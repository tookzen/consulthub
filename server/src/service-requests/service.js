const crypto = require('crypto');
const pool = require('../db');
const { notify } = require('../services/notifications');

function requestReference() {
  return `SR-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

async function addEvent(client, requestId, actorUserId, eventType, fromStatus = null, toStatus = null, details = {}) {
  await client.query(
    `INSERT INTO service_request_events(service_request_id,actor_user_id,event_type,from_status,to_status,details)
     VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
    [requestId, actorUserId || null, eventType, fromStatus, toStatus, JSON.stringify(details || {})]
  );
}

async function notifyProviderPool(client, requestRow, title = 'New service request available') {
  const providers = await client.query(
    `SELECT u.id
       FROM provider_profiles p JOIN users u ON u.id=p.user_id
      WHERE p.category_id=$1 AND p.verification_status='VERIFIED' AND p.accepting_service_requests=TRUE AND u.is_active=TRUE
        AND NOT EXISTS (
          SELECT 1 FROM service_request_provider_exclusions e
           WHERE e.service_request_id=$2 AND e.provider_id=p.id
        )`, [requestRow.category_id, requestRow.id]
  );
  for (const provider of providers.rows) {
    await notify({
      userId: provider.id,
      type: 'SERVICE_REQUEST_AVAILABLE',
      title,
      message: `${requestRow.request_reference}: ${requestRow.title}`,
      relatedType: 'SERVICE_REQUEST', relatedId: requestRow.id, client
    });
  }
}

async function expireProviderClaims() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const expired = await client.query(
      `UPDATE service_requests
          SET status='PROVIDER_TIMEOUT', updated_at=NOW()
        WHERE status='CLAIMED'
          AND provider_action_deadline_at IS NOT NULL
          AND provider_action_deadline_at <= NOW()
      RETURNING id, request_reference, title, category_id, client_user_id, assigned_provider_id`
    );

    for (const row of expired.rows) {
      await addEvent(client, row.id, null, 'PROVIDER_ACTION_TIMEOUT', 'CLAIMED', 'PROVIDER_TIMEOUT');
      await notify({
        userId: row.client_user_id,
        type: 'SERVICE_REQUEST_PROVIDER_TIMEOUT',
        title: 'Provider did not respond in time',
        message: `The provider assigned to ${row.request_reference} did not submit a quote in time. Would you like another provider?`,
        relatedType: 'SERVICE_REQUEST', relatedId: row.id, client
      });
      if (row.assigned_provider_id) {
        const providerUser = await client.query(`SELECT user_id FROM provider_profiles WHERE id=$1`, [row.assigned_provider_id]);
        if (providerUser.rowCount) {
          await notify({
            userId: providerUser.rows[0].user_id,
            type: 'SERVICE_REQUEST_PROVIDER_TIMEOUT',
            title: 'Service request response window expired',
            message: `Your response window for ${row.request_reference} expired.`,
            relatedType: 'SERVICE_REQUEST', relatedId: row.id, client
          });
        }
      }
    }
    await client.query('COMMIT');
    return expired.rowCount;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function reopenRequest(client, row, actorUserId, reason) {
  if (row.assigned_provider_id) {
    await client.query(
      `INSERT INTO service_request_provider_exclusions(service_request_id,provider_id,reason)
       VALUES($1,$2,$3) ON CONFLICT(service_request_id,provider_id) DO UPDATE SET reason=EXCLUDED.reason`,
      [row.id, row.assigned_provider_id, reason || 'Previous provider assignment ended']
    );
  }
  await client.query(`UPDATE service_request_quotes SET status='REJECTED',updated_at=NOW() WHERE service_request_id=$1 AND status IN ('SUBMITTED','ACCEPTED')`, [row.id]);
  const updated = (await client.query(
    `UPDATE service_requests
        SET status='OPEN', assigned_provider_id=NULL, provider_claimed_at=NULL,
            provider_action_deadline_at=NULL, accepted_quote_id=NULL, pool_round=pool_round+1,
            updated_at=NOW()
      WHERE id=$1 RETURNING *`, [row.id]
  )).rows[0];
  await addEvent(client, row.id, actorUserId, 'RETURNED_TO_POOL', row.status, 'OPEN', { reason });
  await notifyProviderPool(client, updated, 'Service request returned to the pool');
  return updated;
}

module.exports = { requestReference, addEvent, notifyProviderPool, expireProviderClaims, reopenRequest };
