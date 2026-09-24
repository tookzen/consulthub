const crypto = require('crypto');

function reference(prefix = 'IDV') {
  return `${prefix}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}

async function verifyIdentity({ legalFirstName, legalLastName, idNumber, documentReference, selfieReference, livenessConfirmed }) {
  const normalizedId = String(idNumber || '').replace(/\s/g, '');
  const hasRequiredData = Boolean(legalFirstName && legalLastName && normalizedId.length >= 6 && documentReference && selfieReference);
  const livenessPassed = Boolean(livenessConfirmed);
  const faceMatchPassed = hasRequiredData && livenessPassed;
  const verified = hasRequiredData && livenessPassed && faceMatchPassed;

  return {
    provider: 'MOCK_IDENTITY_PROVIDER',
    reference: reference(),
    verified,
    documentAuthentic: hasRequiredData,
    livenessPassed,
    faceMatchPassed,
    confidence: verified ? 0.98 : 0.35,
    message: verified
      ? 'Mock identity verification passed.'
      : 'Mock identity verification failed. Complete all identity fields and confirm liveness.'
  };
}

module.exports = { verifyIdentity };
