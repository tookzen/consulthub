const DEMO_REGISTRY = {
  'DEMO-HPCSA-001': {
    firstName: 'Ayanda',
    lastName: 'Nkosi',
    profession: 'General Practitioner',
    category: 'Independent Practice',
    status: 'ACTIVE'
  },
  'DEMO-HPCSA-002': {
    firstName: 'Nandi',
    lastName: 'Khumalo',
    profession: 'General Practitioner',
    category: 'Independent Practice',
    status: 'ACTIVE'
  },
  'HPCSA-DEMO-PENDING': {
    firstName: 'Pending',
    lastName: 'Doctor',
    profession: 'Medical Practitioner',
    category: 'Independent Practice',
    status: 'ACTIVE'
  }
};

async function verifyRegistration({ registrationNumber, firstName, lastName }) {
  const number = String(registrationNumber || '').trim().toUpperCase();
  const record = DEMO_REGISTRY[number];
  const nameMatch = Boolean(record) && record.firstName.toLowerCase() === String(firstName || '').trim().toLowerCase()
    && record.lastName.toLowerCase() === String(lastName || '').trim().toLowerCase();
  const active = record?.status === 'ACTIVE';

  return {
    body: 'HPCSA',
    source: 'MOCK_HPCSA_REGISTRY',
    registrationNumber: number,
    found: Boolean(record),
    nameMatch,
    active,
    verified: Boolean(record && nameMatch && active),
    record: record || null,
    message: !record ? 'Registration number was not found in the mock HPCSA registry.'
      : !nameMatch ? 'Registration exists, but the registered name does not match the verified account name.'
        : !active ? 'Registration exists but is not active.' : 'Mock HPCSA registration verified.'
  };
}

module.exports = { verifyRegistration, DEMO_REGISTRY };
