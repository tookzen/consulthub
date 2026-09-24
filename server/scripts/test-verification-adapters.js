const assert = require('assert');
const identity = require('../src/verification/adapters/mockIdentityProvider');
const hpcsa = require('../src/verification/adapters/mockHpcsa');
const lpc = require('../src/verification/adapters/mockLpc');

(async () => {
  const idPass = await identity.verifyIdentity({
    legalFirstName: 'Ayanda', legalLastName: 'Nkosi', idNumber: '9001015009087',
    documentReference: 'test-id.jpg', selfieReference: 'test-selfie.jpg', livenessConfirmed: true
  });
  assert.equal(idPass.verified, true);

  const idFail = await identity.verifyIdentity({
    legalFirstName: 'Ayanda', legalLastName: 'Nkosi', idNumber: '9001015009087',
    documentReference: 'test-id.jpg', selfieReference: 'test-selfie.jpg', livenessConfirmed: false
  });
  assert.equal(idFail.verified, false);

  const doctorPass = await hpcsa.verifyRegistration({ registrationNumber: 'DEMO-HPCSA-001', firstName: 'Ayanda', lastName: 'Nkosi' });
  assert.equal(doctorPass.verified, true);

  const catfishFail = await hpcsa.verifyRegistration({ registrationNumber: 'DEMO-HPCSA-001', firstName: 'Someone', lastName: 'Else' });
  assert.equal(catfishFail.verified, false);
  assert.equal(catfishFail.nameMatch, false);

  const lawyerPass = await lpc.verifyRegistration({ registrationNumber: 'DEMO-LPC-001', firstName: 'Karabo', lastName: 'Dlamini' });
  assert.equal(lawyerPass.verified, true);

  console.log('Verification adapter tests passed.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
