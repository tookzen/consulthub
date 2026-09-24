const express = require('express');
const pool = require('../db');
const { authenticate, authorize, authorizeAdmin } = require('../auth');
const { verifyIdentity } = require('./adapters/identityFactory');
const { verifyQualification } = require('./adapters/qualificationFactory');
const { getRegistryAdapter } = require('./adapters/registryFactory');
const { notify } = require('../services/notifications');

const router = express.Router();
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const VALID_STATUSES = ['PENDING', 'VERIFIED', 'REJECTED', 'SUSPENDED'];

async function getProviderForUser(userId) {
  const result = await pool.query(
    `SELECT p.*, u.first_name, u.last_name, u.email
       FROM provider_profiles p
       JOIN users u ON u.id = p.user_id
      WHERE p.user_id = $1`, [userId]
  );
  return result.rows[0] || null;
}

async function verificationSummary(providerId) {
  const [identity, registration, qualifications, history] = await Promise.all([
    pool.query(`SELECT * FROM identity_verifications WHERE provider_id=$1 ORDER BY created_at DESC LIMIT 1`, [providerId]),
    pool.query(`SELECT * FROM professional_registrations WHERE provider_id=$1 ORDER BY created_at DESC LIMIT 1`, [providerId]),
    pool.query(`SELECT * FROM professional_qualifications WHERE provider_id=$1 ORDER BY created_at DESC`, [providerId]),
    pool.query(`SELECT h.*, u.first_name AS actor_first_name, u.last_name AS actor_last_name
                  FROM provider_verification_history h
                  LEFT JOIN users u ON u.id = h.actor_user_id
                 WHERE h.provider_id=$1 ORDER BY h.created_at DESC LIMIT 20`, [providerId])
  ]);

  const latestIdentity = identity.rows[0] || null;
  const latestRegistration = registration.rows[0] || null;
  const qualificationRows = qualifications.rows;
  return {
    identity: latestIdentity,
    registration: latestRegistration,
    qualifications: qualificationRows,
    history: history.rows,
    badges: {
      identityVerified: latestIdentity?.status === 'VERIFIED',
      registrationVerified: latestRegistration?.status === 'VERIFIED',
      qualificationsVerified: qualificationRows.length > 0 && qualificationRows.some(q => q.status === 'VERIFIED')
    }
  };
}

async function addHistory(client, { providerId, actorUserId, eventType, fromStatus, toStatus, notes, metadata = {} }) {
  await client.query(
    `INSERT INTO provider_verification_history(provider_id, actor_user_id, event_type, from_status, to_status, notes, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [providerId, actorUserId || null, eventType, fromStatus || null, toStatus || null, notes || null, JSON.stringify(metadata)]
  );
}

router.get('/me', authenticate, authorize('PROVIDER'), asyncRoute(async (req, res) => {
  const provider = await getProviderForUser(req.user.sub);
  if (!provider) return res.status(404).json({ message: 'Provider profile not found.' });
  res.json({ provider, ...(await verificationSummary(provider.id)) });
}));

router.post('/identity', authenticate, authorize('PROVIDER'), asyncRoute(async (req, res) => {
  const provider = await getProviderForUser(req.user.sub);
  if (!provider) return res.status(404).json({ message: 'Provider profile not found.' });
  const { legalFirstName, legalLastName, idNumber, idType = 'SA_ID', documentReference, selfieReference, livenessConfirmed } = req.body;
  if (!legalFirstName || !legalLastName || !idNumber || !documentReference || !selfieReference) {
    return res.status(400).json({ message: 'Legal name, ID/passport number, document reference and selfie reference are required.' });
  }
  if (legalFirstName.trim().toLowerCase() !== provider.first_name.toLowerCase() || legalLastName.trim().toLowerCase() !== provider.last_name.toLowerCase()) {
    return res.status(400).json({ message: 'Legal name must match the name on your ConsultHub account.' });
  }

  const result = await verifyIdentity({ legalFirstName, legalLastName, idNumber, documentReference, selfieReference, livenessConfirmed });
  const status = result.verified ? 'VERIFIED' : 'REJECTED';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const saved = await client.query(
      `INSERT INTO identity_verifications(provider_id, legal_first_name, legal_last_name, id_type, id_number_last4,
        document_reference, selfie_reference, provider_name, provider_reference, document_authentic, liveness_passed,
        face_match_passed, confidence, status, checked_at, raw_result)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),$15::jsonb)
       RETURNING *`,
      [provider.id, legalFirstName.trim(), legalLastName.trim(), idType, String(idNumber).slice(-4), documentReference,
        selfieReference, result.provider, result.reference, result.documentAuthentic, result.livenessPassed,
        result.faceMatchPassed, result.confidence, status, JSON.stringify(result)]
    );
    await addHistory(client, { providerId: provider.id, actorUserId: req.user.sub, eventType: 'IDENTITY_CHECK', notes: result.message, metadata: { status, providerReference: result.reference } });
    await client.query('COMMIT');
    res.status(201).json({ identity: saved.rows[0], result });
  } catch (error) {
    await client.query('ROLLBACK'); throw error;
  } finally { client.release(); }
}));

router.post('/professional-registration', authenticate, authorize('PROVIDER'), asyncRoute(async (req, res) => {
  const provider = await getProviderForUser(req.user.sub);
  if (!provider) return res.status(404).json({ message: 'Provider profile not found.' });
  const { regulatoryBody, registrationNumber, registrationCategory } = req.body;
  if (!regulatoryBody || !registrationNumber) return res.status(400).json({ message: 'Regulatory body and registration number are required.' });

  const adapter = getRegistryAdapter(regulatoryBody);
  const result = await adapter.verifyRegistration({ registrationNumber, firstName: provider.first_name, lastName: provider.last_name });
  const status = result.verified ? 'VERIFIED' : 'REJECTED';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const saved = await client.query(
      `INSERT INTO professional_registrations(provider_id, regulatory_body, registration_number, registration_category,
         registration_status, name_match, source, status, verified_at, next_verification_at, raw_result)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $8='VERIFIED' THEN NOW() ELSE NULL END,
               CASE WHEN $8='VERIFIED' THEN NOW()+INTERVAL '30 days' ELSE NULL END,$9::jsonb)
       RETURNING *`,
      [provider.id, String(regulatoryBody).toUpperCase(), String(registrationNumber).trim().toUpperCase(), registrationCategory || result.record?.category || result.record?.practitionerType || null,
        result.record?.status || (result.active ? 'ACTIVE' : 'UNKNOWN'), result.nameMatch, result.source, status, JSON.stringify(result)]
    );
    await client.query(`UPDATE provider_profiles SET registration_number=$1, updated_at=NOW() WHERE id=$2`, [String(registrationNumber).trim().toUpperCase(), provider.id]);
    await addHistory(client, { providerId: provider.id, actorUserId: req.user.sub, eventType: 'PROFESSIONAL_REGISTRY_CHECK', notes: result.message, metadata: { status, body: regulatoryBody } });
    await client.query('COMMIT');
    res.status(201).json({ registration: saved.rows[0], result });
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}));

router.post('/qualification', authenticate, authorize('PROVIDER'), asyncRoute(async (req, res) => {
  const provider = await getProviderForUser(req.user.sub);
  if (!provider) return res.status(404).json({ message: 'Provider profile not found.' });
  const { institution, qualificationName, qualificationNumber, yearAwarded, country = 'South Africa', documentReference } = req.body;
  if (!institution || !qualificationName || !documentReference) return res.status(400).json({ message: 'Institution, qualification name and document reference are required.' });

  const qualificationResult=await verifyQualification({institution,qualificationName,qualificationNumber,yearAwarded,country,documentReference,firstName:provider.first_name,lastName:provider.last_name});
  const status=qualificationResult.verified?'VERIFIED':'REJECTED';
  const source=qualificationResult.source;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const saved = await client.query(
      `INSERT INTO professional_qualifications(provider_id,institution,qualification_name,qualification_number,year_awarded,country,
         document_reference,verification_source,verification_reference,status,verified_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CASE WHEN $10='VERIFIED' THEN NOW() ELSE NULL END)
       RETURNING *`,
      [provider.id, institution.trim(), qualificationName.trim(), qualificationNumber || null, yearAwarded ? Number(yearAwarded) : null,
        country, documentReference, source, qualificationResult.reference || `QUAL-${Date.now()}`, status]
    );
    await addHistory(client, { providerId: provider.id, actorUserId: req.user.sub, eventType: 'QUALIFICATION_CHECK', notes: `${source}: ${status}`, metadata: { qualificationName, institution } });
    await client.query('COMMIT');
    res.status(201).json({ qualification: saved.rows[0] });
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}));

router.post('/submit', authenticate, authorize('PROVIDER'), asyncRoute(async (req, res) => {
  const provider = await getProviderForUser(req.user.sub);
  if (!provider) return res.status(404).json({ message: 'Provider profile not found.' });
  if (provider.verification_status === 'SUSPENDED') {
    return res.status(403).json({ message: 'This professional account is suspended. An administrator must lift the suspension before resubmission.' });
  }
  const summary = await verificationSummary(provider.id);
  if (!summary.badges.identityVerified || !summary.badges.registrationVerified || !summary.badges.qualificationsVerified) {
    return res.status(400).json({ message: 'Identity, professional registration and at least one qualification must all be verified before admin review.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = provider.verification_status;
    await client.query(`UPDATE provider_profiles SET verification_status='PENDING', verification_submitted_at=NOW(), updated_at=NOW() WHERE id=$1`, [provider.id]);
    await addHistory(client, { providerId: provider.id, actorUserId: req.user.sub, eventType: 'APPLICATION_SUBMITTED', fromStatus: before, toStatus: 'PENDING', notes: 'Provider submitted verification package for admin approval.' });
    await notify({ userId: req.user.sub, type: 'VERIFICATION_SUBMITTED', title: 'Verification submitted', message: 'Your professional verification package is awaiting administrator review.', relatedType: 'PROVIDER', relatedId: provider.id, client });
    await client.query('COMMIT');
    res.json({ message: 'Verification package submitted for admin review.', status: 'PENDING' });
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}));

router.get('/admin/applications', authenticate, authorizeAdmin('verification:read'), asyncRoute(async (req, res) => {
  const status = req.query.status ? String(req.query.status).toUpperCase() : null;
  if (status && !VALID_STATUSES.includes(status)) return res.status(400).json({ message: 'Invalid verification status.' });
  const result = await pool.query(
    `SELECT p.id, p.profession, p.registration_number, p.verification_status, p.verification_submitted_at, p.verified_at,
            u.first_name, u.last_name, u.email, c.name AS category_name,
            EXISTS(SELECT 1 FROM identity_verifications i WHERE i.provider_id=p.id AND i.status='VERIFIED') AS identity_verified,
            EXISTS(SELECT 1 FROM professional_registrations r WHERE r.provider_id=p.id AND r.status='VERIFIED') AS registration_verified,
            EXISTS(SELECT 1 FROM professional_qualifications q WHERE q.provider_id=p.id AND q.status='VERIFIED') AS qualification_verified
       FROM provider_profiles p
       JOIN users u ON u.id=p.user_id
       LEFT JOIN service_categories c ON c.id=p.category_id
      WHERE ($1::text IS NULL OR p.verification_status=$1)
      ORDER BY p.verification_submitted_at DESC NULLS LAST, p.created_at DESC`, [status]
  );
  res.json({ applications: result.rows });
}));

router.get('/admin/applications/:providerId', authenticate, authorizeAdmin('verification:read'), asyncRoute(async (req, res) => {
  const providerResult = await pool.query(
    `SELECT p.*, u.first_name, u.last_name, u.email, u.phone, c.name AS category_name
       FROM provider_profiles p JOIN users u ON u.id=p.user_id
       LEFT JOIN service_categories c ON c.id=p.category_id WHERE p.id=$1`, [req.params.providerId]
  );
  if (!providerResult.rowCount) return res.status(404).json({ message: 'Provider not found.' });
  res.json({ provider: providerResult.rows[0], ...(await verificationSummary(req.params.providerId)) });
}));

router.patch('/admin/applications/:providerId/status', authenticate, authorizeAdmin('verification:write'), asyncRoute(async (req, res) => {
  const status = String(req.body.status || '').toUpperCase();
  const notes = String(req.body.notes || '').trim();
  if (!VALID_STATUSES.includes(status)) return res.status(400).json({ message: 'Status must be PENDING, VERIFIED, REJECTED or SUSPENDED.' });
  if (['REJECTED', 'SUSPENDED'].includes(status) && !notes) return res.status(400).json({ message: 'Admin notes are required when rejecting or suspending a provider.' });

  const current = await pool.query(`SELECT * FROM provider_profiles WHERE id=$1`, [req.params.providerId]);
  if (!current.rowCount) return res.status(404).json({ message: 'Provider not found.' });
  if (status === 'VERIFIED') {
    const summary = await verificationSummary(req.params.providerId);
    if (!summary.badges.identityVerified || !summary.badges.registrationVerified || !summary.badges.qualificationsVerified) {
      return res.status(400).json({ message: 'Cannot approve: identity, registration and qualification checks must all be verified.' });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE provider_profiles SET verification_status=$1, verified_at=CASE WHEN $1='VERIFIED' THEN NOW() ELSE verified_at END,
              verified_by=CASE WHEN $1='VERIFIED' THEN $2 ELSE verified_by END,
              suspension_reason=CASE WHEN $1='SUSPENDED' THEN $3 ELSE NULL END,
              rejection_reason=CASE WHEN $1='REJECTED' THEN $3 ELSE NULL END,
              updated_at=NOW()
       WHERE id=$4 RETURNING *`, [status, req.user.sub, notes || null, req.params.providerId]
    );
    await client.query(
      `INSERT INTO admin_verification_reviews(provider_id,admin_user_id,decision,notes) VALUES ($1,$2,$3,$4)`,
      [req.params.providerId, req.user.sub, status, notes || null]
    );
    await addHistory(client, { providerId: req.params.providerId, actorUserId: req.user.sub, eventType: 'ADMIN_STATUS_CHANGE', fromStatus: current.rows[0].verification_status, toStatus: status, notes });
    await notify({ userId: current.rows[0].user_id, type: 'VERIFICATION_STATUS_CHANGED', title: `Professional verification ${status.toLowerCase()}`, message: notes || `Your professional verification status is now ${status}.`, relatedType: 'PROVIDER', relatedId: req.params.providerId, client });
    await client.query('COMMIT');
    res.json({ provider: updated.rows[0] });
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}));

module.exports = router;
