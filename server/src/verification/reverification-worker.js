const pool=require('../db');const {getRegistryAdapter}=require('./adapters/registryFactory');const {notify}=require('../services/notifications');
async function runReverification(){
  const due=await pool.query(`SELECT r.*,p.user_id,u.first_name,u.last_name,p.verification_status FROM professional_registrations r JOIN provider_profiles p ON p.id=r.provider_id JOIN users u ON u.id=p.user_id WHERE r.status='VERIFIED' AND r.next_verification_at IS NOT NULL AND r.next_verification_at<=NOW() ORDER BY r.next_verification_at LIMIT 50`);
  for(const row of due.rows){
    const client=await pool.connect();
    try{
      const result=await getRegistryAdapter(row.regulatory_body).verifyRegistration({registrationNumber:row.registration_number,firstName:row.first_name,lastName:row.last_name});
      await client.query('BEGIN');
      await client.query(`UPDATE professional_registrations SET registration_status=$2,name_match=$3,status=$4,verified_at=CASE WHEN $4='VERIFIED' THEN NOW() ELSE verified_at END,next_verification_at=CASE WHEN $4='VERIFIED' THEN NOW()+INTERVAL '30 days' ELSE NULL END,raw_result=$5::jsonb WHERE id=$1`,[row.id,result.record?.status||'UNKNOWN',Boolean(result.nameMatch),result.verified?'VERIFIED':'REJECTED',JSON.stringify(result)]);
      if(!result.verified){
        await client.query(`UPDATE provider_profiles SET verification_status='SUSPENDED',suspension_reason='Scheduled professional registration re-verification failed.',updated_at=NOW() WHERE id=$1`,[row.provider_id]);
        await client.query(`INSERT INTO compliance_cases(subject_user_id,provider_id,case_type,priority,summary,details) VALUES($1,$2,'PROFESSIONAL_REVERIFICATION','HIGH','Professional registration re-verification failed',$3)`,[row.user_id,row.provider_id,result.message||'Scheduled registry check did not pass.']);
      }
      await client.query(`INSERT INTO provider_verification_history(provider_id,event_type,from_status,to_status,notes,metadata) VALUES($1,'SCHEDULED_REGISTRY_REVERIFICATION',$2,$3,$4,$5::jsonb)`,[row.provider_id,row.verification_status,result.verified?row.verification_status:'SUSPENDED',result.message||null,JSON.stringify({registrationId:row.id,regulatoryBody:row.regulatory_body})]);
      await notify({userId:row.user_id,type:'PROFESSIONAL_REVERIFICATION',title:result.verified?'Professional registration re-verified':'Professional registration requires review',message:result.verified?'Your professional registration remains verified.':'Your professional account has been suspended pending an administrator review because the scheduled registration check did not pass.',channel:'IN_APP',client});
      await client.query('COMMIT');
    }catch(e){await client.query('ROLLBACK');console.error('Professional re-verification failed:',row.id,e.message);}finally{client.release();}
  }
  return due.rowCount;
}
module.exports={runReverification};
