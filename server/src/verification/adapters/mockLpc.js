const DEMO_REGISTRY = {
  'DEMO-LPC-001': {
    firstName: 'Karabo',
    lastName: 'Dlamini',
    practitionerType: 'Attorney',
    province: 'Gauteng',
    status: 'PRACTISING'
  },
  'LPC-DEMO-PENDING': {
    firstName: 'Pending',
    lastName: 'Lawyer',
    practitionerType: 'Attorney',
    province: 'Gauteng',
    status: 'PRACTISING'
  }
};

async function verifyRegistration({ registrationNumber, firstName, lastName }) {
  const number = String(registrationNumber || '').trim().toUpperCase();
  const record = DEMO_REGISTRY[number];
  const nameMatch = Boolean(record) && record.firstName.toLowerCase() === String(firstName || '').trim().toLowerCase()
    && record.lastName.toLowerCase() === String(lastName || '').trim().toLowerCase();
  const active = record?.status === 'PRACTISING';

  return {
    body: 'LPC',
    source: 'MOCK_LPC_REGISTRY',
    registrationNumber: number,
    found: Boolean(record),
    nameMatch,
    active,
    verified: Boolean(record && nameMatch && active),
    record: record || null,
    message: !record ? 'Practitioner number was not found in the mock LPC registry.'
      : !nameMatch ? 'Registration exists, but the practitioner name does not match the verified account name.'
        : !active ? 'Practitioner exists but is not currently practising.' : 'Mock LPC registration verified.'
  };
}

module.exports = { verifyRegistration, DEMO_REGISTRY };
