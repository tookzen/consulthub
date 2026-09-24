const express = require('express');
const pool = require('../db');
const { authenticate, authorize } = require('../auth');
const { notify } = require('../services/notifications');
const { requestReference, addEvent, notifyProviderPool, expireProviderClaims, reopenRequest } = require('./service');

const router = express.Router();
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function verifiedProvider(userId) {
  const result = await pool.query(
    `SELECT p.id,p.category_id,p.profession,p.verification_status,p.accepting_service_requests,u.is_active,u.first_name,u.last_name
       FROM provider_profiles p JOIN users u ON u.id=p.user_id
      WHERE p.user_id=$1`, [userId]
  );
  if (!result.rowCount) return null;
  const row = result.rows[0];
  if (!row.is_active || row.verification_status !== 'VERIFIED') return null;
  return row;
}

async function requestForClient(id, userId, client = pool) {
  const r = await client.query(`SELECT * FROM service_requests WHERE id=$1 AND client_user_id=$2`, [id, userId]);
  return r.rows[0] || null;
}

router.use(authenticate);

router.post('/', authorize('CLIENT'), asyncRoute(async (req, res) => {
  const { categoryId, title, description, budgetMin, budgetMax, currency = 'ZAR', preferredStartAt, providerActionMinutes = 60 } = req.body;
  const actionMinutes = Number(providerActionMinutes);
  if (!categoryId || !String(title || '').trim() || !String(description || '').trim()) {
    return res.status(400).json({ message: 'Category, title and description are required.' });
  }
  if (!Number.isInteger(actionMinutes) || actionMinutes < 5 || actionMinutes > 1440) {
    return res.status(400).json({ message: 'Provider action period must be between 5 and 1440 minutes.' });
  }
  const min = budgetMin === '' || budgetMin == null ? null : Number(budgetMin);
  const max = budgetMax === '' || budgetMax == null ? null : Number(budgetMax);
  if ((min != null && (!Number.isFinite(min) || min < 0)) || (max != null && (!Number.isFinite(max) || max < 0)) || (min != null && max != null && min > max)) {
    return res.status(400).json({ message: 'Budget range is invalid.' });
  }
  const cat = await pool.query(`SELECT 1 FROM service_categories WHERE id=$1`, [categoryId]);
  if (!cat.rowCount) return res.status(400).json({ message: 'Category not found.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `INSERT INTO service_requests(request_reference,client_user_id,category_id,title,description,budget_min,budget_max,currency,preferred_start_at,provider_action_minutes)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [requestReference(), req.user.sub, categoryId, String(title).trim(), String(description).trim(), min, max, String(currency).toUpperCase(), preferredStartAt || null, actionMinutes]
    );
    await addEvent(client, r.rows[0].id, req.user.sub, 'REQUEST_POSTED', null, 'OPEN');
    await notifyProviderPool(client, r.rows[0]);
    await client.query('COMMIT');
    res.status(201).json({ request: r.rows[0] });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}));

router.get('/mine', authorize('CLIENT'), asyncRoute(async (req, res) => {
  await expireProviderClaims();
  const r = await pool.query(
    `SELECT sr.*,c.name category_name,
            pu.first_name provider_first_name,pu.last_name provider_last_name,p.profession provider_profession,
            q.id quote_id,q.amount quote_amount,q.currency quote_currency,q.message quote_message,
            q.estimated_duration_minutes,q.valid_until quote_valid_until,q.status quote_status
       FROM service_requests sr
       JOIN service_categories c ON c.id=sr.category_id
       LEFT JOIN provider_profiles p ON p.id=sr.assigned_provider_id
       LEFT JOIN users pu ON pu.id=p.user_id
       LEFT JOIN LATERAL (
         SELECT * FROM service_request_quotes sq WHERE sq.service_request_id=sr.id
         ORDER BY sq.created_at DESC LIMIT 1
       ) q ON TRUE
      WHERE sr.client_user_id=$1
      ORDER BY sr.created_at DESC`, [req.user.sub]
  );
  res.json({ requests: r.rows });
}));

router.get('/pool', authorize('PROVIDER'), asyncRoute(async (req, res) => {
  await expireProviderClaims();
  const provider = await verifiedProvider(req.user.sub);
  if (!provider) return res.status(403).json({ message: 'Only active, verified providers can access the service-request pool.' });
  if (!provider.accepting_service_requests) return res.json({ requests: [], provider, paused: true });
  const r = await pool.query(
    `SELECT sr.*,c.name category_name
       FROM service_requests sr
       JOIN service_categories c ON c.id=sr.category_id
      WHERE sr.status='OPEN' AND sr.category_id=$1
        AND NOT EXISTS (SELECT 1 FROM service_request_provider_exclusions e WHERE e.service_request_id=sr.id AND e.provider_id=$2)
      ORDER BY sr.created_at ASC`, [provider.category_id,provider.id]
  );
  res.json({ requests: r.rows, provider });
}));

router.get('/assigned', authorize('PROVIDER'), asyncRoute(async (req, res) => {
  await expireProviderClaims();
  const provider = await verifiedProvider(req.user.sub);
  if (!provider) return res.status(403).json({ message: 'Only active, verified providers can access assigned requests.' });
  const r = await pool.query(
    `SELECT sr.*,c.name category_name,u.first_name client_first_name,u.last_name client_last_name,
            q.id quote_id,q.amount quote_amount,q.currency quote_currency,q.message quote_message,
            q.estimated_duration_minutes,q.valid_until quote_valid_until,q.status quote_status
       FROM service_requests sr
       JOIN service_categories c ON c.id=sr.category_id
       JOIN users u ON u.id=sr.client_user_id
       LEFT JOIN LATERAL (
         SELECT * FROM service_request_quotes sq WHERE sq.service_request_id=sr.id AND sq.provider_id=$1
         ORDER BY sq.created_at DESC LIMIT 1
       ) q ON TRUE
      WHERE sr.assigned_provider_id=$1 AND sr.status IN ('CLAIMED','QUOTED','ACCEPTED','PROVIDER_TIMEOUT')
      ORDER BY sr.updated_at DESC`, [provider.id]
  );
  res.json({ requests: r.rows, provider });
}));

router.post('/:id/claim', authorize('PROVIDER'), asyncRoute(async (req, res) => {
  await expireProviderClaims();
  const provider = await verifiedProvider(req.user.sub);
  if (!provider) return res.status(403).json({ message: 'Only active, verified providers can claim service requests.' });
  if (!provider.accepting_service_requests) return res.status(409).json({ message: 'Turn on Accepting new service requests before claiming work.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rr = await client.query(`SELECT * FROM service_requests WHERE id=$1 FOR UPDATE`, [req.params.id]);
    if (!rr.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Service request not found.' }); }
    const row = rr.rows[0];
    if (row.status !== 'OPEN') { await client.query('ROLLBACK'); return res.status(409).json({ message: 'This request has already been claimed or closed.' }); }
    if (String(row.category_id) !== String(provider.category_id)) { await client.query('ROLLBACK'); return res.status(403).json({ message: 'This request is outside your approved service category.' }); }
    const excluded = await client.query(`SELECT 1 FROM service_request_provider_exclusions WHERE service_request_id=$1 AND provider_id=$2`, [row.id,provider.id]);
    if (excluded.rowCount) { await client.query('ROLLBACK'); return res.status(409).json({ message: 'This request was returned from your previous assignment and is now reserved for other providers.' }); }
    const updated = (await client.query(
      `UPDATE service_requests
          SET status='CLAIMED',assigned_provider_id=$2,provider_claimed_at=NOW(),
              provider_action_deadline_at=NOW()+($3::text || ' minutes')::interval,updated_at=NOW()
        WHERE id=$1 RETURNING *`, [row.id, provider.id, row.provider_action_minutes]
    )).rows[0];
    await addEvent(client, row.id, req.user.sub, 'PROVIDER_CLAIMED', 'OPEN', 'CLAIMED', { deadline: updated.provider_action_deadline_at });
    await notify({ userId: row.client_user_id, type:'SERVICE_REQUEST_CLAIMED', title:'A provider accepted your request', message:`${provider.first_name} ${provider.last_name} has accepted ${row.request_reference} and must submit a quote before ${new Date(updated.provider_action_deadline_at).toLocaleString('en-ZA')}.`, relatedType:'SERVICE_REQUEST', relatedId:row.id, client });
    await client.query('COMMIT');
    res.json({ request: updated });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}));

router.post('/:id/quote', authorize('PROVIDER'), asyncRoute(async (req, res) => {
  await expireProviderClaims();
  const provider = await verifiedProvider(req.user.sub);
  if (!provider) return res.status(403).json({ message: 'Only active, verified providers can quote.' });
  const amount = Number(req.body.amount);
  const estimated = req.body.estimatedDurationMinutes == null || req.body.estimatedDurationMinutes === '' ? null : Number(req.body.estimatedDurationMinutes);
  if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ message:'A valid quote amount is required.' });
  if (estimated != null && (!Number.isInteger(estimated) || estimated < 5 || estimated > 10080)) return res.status(400).json({ message:'Estimated duration must be between 5 and 10080 minutes.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rr = await client.query(`SELECT * FROM service_requests WHERE id=$1 FOR UPDATE`, [req.params.id]);
    if (!rr.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ message:'Service request not found.' }); }
    const row = rr.rows[0];
    if (row.status !== 'CLAIMED' || String(row.assigned_provider_id) !== String(provider.id)) { await client.query('ROLLBACK'); return res.status(409).json({ message:'This request is not currently assigned to you for quoting.' }); }
    if (row.provider_action_deadline_at && new Date(row.provider_action_deadline_at) <= new Date()) { await client.query('ROLLBACK'); await expireProviderClaims(); return res.status(409).json({ message:'The quote response window has expired.' }); }
    const quote = (await client.query(
      `INSERT INTO service_request_quotes(service_request_id,provider_id,amount,currency,message,estimated_duration_minutes,valid_until)
       VALUES($1,$2,$3,$4,$5,$6,NOW()+INTERVAL '7 days') RETURNING *`,
      [row.id,provider.id,amount,String(req.body.currency||row.currency||'ZAR').toUpperCase(),String(req.body.message||'').trim()||null,estimated]
    )).rows[0];
    await client.query(`UPDATE service_requests SET status='QUOTED',provider_action_deadline_at=NULL,updated_at=NOW() WHERE id=$1`, [row.id]);
    await addEvent(client,row.id,req.user.sub,'QUOTE_SUBMITTED','CLAIMED','QUOTED',{quoteId:quote.id,amount:quote.amount,currency:quote.currency});
    await notify({userId:row.client_user_id,type:'SERVICE_REQUEST_QUOTED',title:'Quote received',message:`A provider submitted a ${quote.currency} ${quote.amount} quote for ${row.request_reference}.`,relatedType:'SERVICE_REQUEST',relatedId:row.id,client});
    await client.query('COMMIT');
    res.status(201).json({ quote });
  } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}));

router.post('/:id/return-to-pool', asyncRoute(async (req, res) => {
  if (!['CLIENT','PROVIDER'].includes(req.user.role)) return res.status(403).json({message:'Not allowed.'});
  await expireProviderClaims();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rr = await client.query(`SELECT * FROM service_requests WHERE id=$1 FOR UPDATE`, [req.params.id]);
    if (!rr.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({message:'Service request not found.'}); }
    const row = rr.rows[0];
    let allowed = false;
    if (req.user.role === 'CLIENT') allowed = String(row.client_user_id) === String(req.user.sub) && ['CLAIMED','QUOTED','ACCEPTED','PROVIDER_TIMEOUT'].includes(row.status);
    if (req.user.role === 'PROVIDER') {
      const p = await verifiedProvider(req.user.sub);
      allowed = p && String(row.assigned_provider_id) === String(p.id) && row.status === 'CLAIMED';
    }
    if (!allowed) { await client.query('ROLLBACK'); return res.status(409).json({message:'This request cannot be returned to the pool from its current state.'}); }
    const oldProviderId = row.assigned_provider_id;
    const updated = await reopenRequest(client,row,req.user.sub,req.body.reason||'Returned to provider pool');
    if (req.user.role === 'CLIENT' && oldProviderId) {
      const pu = await client.query(`SELECT user_id FROM provider_profiles WHERE id=$1`,[oldProviderId]);
      if (pu.rowCount) await notify({userId:pu.rows[0].user_id,type:'SERVICE_REQUEST_RETURNED',title:'Service request returned to pool',message:`The client returned ${row.request_reference} to the provider pool.`,relatedType:'SERVICE_REQUEST',relatedId:row.id,client});
    }
    if (req.user.role === 'PROVIDER') await notify({userId:row.client_user_id,type:'SERVICE_REQUEST_RETURNED',title:'Request returned to provider pool',message:`The provider released ${row.request_reference}. It is available to other approved providers again.`,relatedType:'SERVICE_REQUEST',relatedId:row.id,client});
    await client.query('COMMIT');
    res.json({ request: updated });
  } catch(e){await client.query('ROLLBACK');throw e;} finally{client.release();}
}));

router.post('/:id/timeout-response', authorize('CLIENT'), asyncRoute(async (req,res)=>{
  await expireProviderClaims();
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const row=await requestForClient(req.params.id,req.user.sub,client);
    if(!row){await client.query('ROLLBACK');return res.status(404).json({message:'Service request not found.'});}
    if(row.status!=='PROVIDER_TIMEOUT'){await client.query('ROLLBACK');return res.status(409).json({message:'This request is not awaiting a timeout decision.'});}
    if(req.body.findAnotherProvider===true){
      const updated=await reopenRequest(client,row,req.user.sub,'Client requested another provider after timeout');
      await notify({userId:req.user.sub,type:'SERVICE_REQUEST_REOPENED',title:'Request returned to provider pool',message:`${row.request_reference} is open to approved providers again.`,relatedType:'SERVICE_REQUEST',relatedId:row.id,client});
      await client.query('COMMIT');return res.json({request:updated});
    }
    const updated=(await client.query(`UPDATE service_requests SET status='CANCELLED',closed_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *`,[row.id])).rows[0];
    await addEvent(client,row.id,req.user.sub,'CLIENT_DECLINED_REASSIGNMENT','PROVIDER_TIMEOUT','CANCELLED');
    await client.query('COMMIT');res.json({request:updated});
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}));

router.post('/:id/accept-quote', authorize('CLIENT'), asyncRoute(async(req,res)=>{
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const row=await requestForClient(req.params.id,req.user.sub,client);
    if(!row){await client.query('ROLLBACK');return res.status(404).json({message:'Service request not found.'});}
    if(row.status!=='QUOTED'){await client.query('ROLLBACK');return res.status(409).json({message:'There is no quote awaiting acceptance.'});}
    const qr=await client.query(`SELECT * FROM service_request_quotes WHERE service_request_id=$1 AND provider_id=$2 AND status='SUBMITTED' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,[row.id,row.assigned_provider_id]);
    if(!qr.rowCount){await client.query('ROLLBACK');return res.status(409).json({message:'Quote not found.'});}
    const quote=qr.rows[0];
    await client.query(`UPDATE service_request_quotes SET status='ACCEPTED',updated_at=NOW() WHERE id=$1`,[quote.id]);
    const updated=(await client.query(`UPDATE service_requests SET status='ACCEPTED',accepted_quote_id=$2,updated_at=NOW() WHERE id=$1 RETURNING *`,[row.id,quote.id])).rows[0];
    await addEvent(client,row.id,req.user.sub,'QUOTE_ACCEPTED','QUOTED','ACCEPTED',{quoteId:quote.id});
    const pu=await client.query(`SELECT user_id FROM provider_profiles WHERE id=$1`,[row.assigned_provider_id]);
    if(pu.rowCount)await notify({userId:pu.rows[0].user_id,type:'SERVICE_REQUEST_QUOTE_ACCEPTED',title:'Your quote was accepted',message:`The client accepted your quote for ${row.request_reference}.`,relatedType:'SERVICE_REQUEST',relatedId:row.id,client});
    await client.query('COMMIT');res.json({request:updated,quote});
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}));

router.post('/:id/cancel', authorize('CLIENT'), asyncRoute(async(req,res)=>{
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const row=await requestForClient(req.params.id,req.user.sub,client);
    if(!row){await client.query('ROLLBACK');return res.status(404).json({message:'Service request not found.'});}
    if(['CANCELLED','COMPLETED'].includes(row.status)){await client.query('ROLLBACK');return res.status(409).json({message:'Request is already closed.'});}
    await client.query(`UPDATE service_request_quotes SET status=CASE WHEN status IN ('SUBMITTED','ACCEPTED') THEN 'REJECTED' ELSE status END,updated_at=NOW() WHERE service_request_id=$1`,[row.id]);
    const updated=(await client.query(`UPDATE service_requests SET status='CANCELLED',closed_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *`,[row.id])).rows[0];
    await addEvent(client,row.id,req.user.sub,'REQUEST_CANCELLED',row.status,'CANCELLED',{reason:req.body.reason||null});
    if(row.assigned_provider_id){const pu=await client.query(`SELECT user_id FROM provider_profiles WHERE id=$1`,[row.assigned_provider_id]);if(pu.rowCount)await notify({userId:pu.rows[0].user_id,type:'SERVICE_REQUEST_CANCELLED',title:'Service request cancelled',message:`The client cancelled ${row.request_reference}.`,relatedType:'SERVICE_REQUEST',relatedId:row.id,client});}
    await client.query('COMMIT');res.json({request:updated});
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}));


router.patch('/availability', authorize('PROVIDER'), asyncRoute(async(req,res)=>{
  if(typeof req.body.acceptingServiceRequests!=='boolean')return res.status(400).json({message:'acceptingServiceRequests must be true or false.'});
  const r=await pool.query(`UPDATE provider_profiles SET accepting_service_requests=$2,updated_at=NOW() WHERE user_id=$1 RETURNING id,verification_status,accepting_service_requests`,[req.user.sub,req.body.acceptingServiceRequests]);
  if(!r.rowCount)return res.status(404).json({message:'Provider profile not found.'});
  res.json({provider:r.rows[0]});
}));

module.exports = router;
