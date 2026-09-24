const mock=require('./mockIdentityProvider');
const production=require('./production');
function verifyIdentity(payload){return String(process.env.VERIFICATION_MODE||'MOCK').toUpperCase()==='PRODUCTION'?production.verifyIdentity(payload):mock.verifyIdentity(payload);}
module.exports={verifyIdentity};
