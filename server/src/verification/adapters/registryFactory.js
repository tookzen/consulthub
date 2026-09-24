const hpcsa=require('./mockHpcsa');
const lpc=require('./mockLpc');
const production=require('./production');
function getRegistryAdapter(body){
  const normalized=String(body||'').trim().toUpperCase();
  if(String(process.env.VERIFICATION_MODE||'MOCK').toUpperCase()==='PRODUCTION')return {verifyRegistration:payload=>production.verifyRegistry(normalized,payload)};
  if(normalized==='HPCSA')return hpcsa;if(normalized==='LPC')return lpc;
  return {async verifyRegistration({registrationNumber}){return {body:normalized||'OTHER',source:'MOCK_GENERIC_REGISTRY',registrationNumber,found:true,nameMatch:true,active:true,verified:true,record:{status:'ACTIVE',note:'Generic mock registry auto-approval for development.'},message:'Generic mock professional registry verification passed.'};}};
}
module.exports={getRegistryAdapter};
