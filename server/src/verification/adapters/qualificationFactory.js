const production=require('./production');
async function verifyQualification(payload){
  if(String(process.env.VERIFICATION_MODE||'MOCK').toUpperCase()==='PRODUCTION')return production.verifyQualification(payload);
  const verified=String(payload.institution||'').trim().length>=3&&String(payload.qualificationName||'').trim().length>=3&&Boolean(payload.documentReference);
  return {verified,source:String(payload.country||'South Africa').toLowerCase()==='south africa'?'MOCK_SAQA_NLRD':'MOCK_SAQA_FOREIGN_EVALUATION',reference:`QUAL-${Date.now()}`,message:verified?'Mock qualification verification passed.':'Mock qualification verification failed.',raw:{developmentOnly:true}};
}
module.exports={verifyQualification};
