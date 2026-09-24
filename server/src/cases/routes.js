const express=require('express');
const pool=require('../db');
const {authenticate,authorize}=require('../auth');
const {reference}=require('../services/helpers');
const {notify}=require('../services/notifications');
const {audit}=require('../services/audit');

const router=express.Router();
const asyncRoute=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
router.use(authenticate);

async function providerForUser(userId,client=pool){const r=await client.query(`SELECT * FROM provider_profiles WHERE user_id=$1`,[userId]);return r.rows[0]||null;}
async function caseAccess(caseId,user,client=pool){
  const r=await client.query(`SELECT c.*,op.user_id originating_provider_user_id,cp.user_id current_provider_user_id,
    EXISTS(SELECT 1 FROM case_provider_access a JOIN provider_profiles px ON px.id=a.provider_id WHERE a.case_id=c.id AND px.user_id=$2 AND a.revoked_at IS NULL AND (a.valid_until IS NULL OR a.valid_until>NOW())) has_provider_grant
    FROM consultation_cases c
    JOIN provider_profiles op ON op.id=c.originating_provider_id
    JOIN provider_profiles cp ON cp.id=c.current_provider_id
    WHERE c.id=$1`,[caseId,user.sub]);
  if(!r.rowCount)return null;const c=r.rows[0];
  const allowed=user.role==='ADMIN'||c.client_user_id===user.sub||c.originating_provider_user_id===user.sub||c.current_provider_user_id===user.sub||c.has_provider_grant;
  return allowed?c:null;
}
async function appointmentParticipant(appointmentId,user,client=pool){
  const r=await client.query(`SELECT a.*,p.user_id provider_user_id,COALESCE(aw.workflow_key,'GENERAL') workflow_key,s.category_id,s.name service_name
    FROM appointments a JOIN provider_profiles p ON p.id=a.provider_id JOIN provider_services s ON s.id=a.service_id LEFT JOIN appointment_workflows aw ON aw.appointment_id=a.id WHERE a.id=$1`,[appointmentId]);
  if(!r.rowCount)return null;const a=r.rows[0];if(user.role==='ADMIN'||[a.client_user_id,a.provider_user_id].includes(user.sub))return a;return null;
}

router.post('/from-appointment/:appointmentId',asyncRoute(async(req,res)=>{
  const a=await appointmentParticipant(req.params.appointmentId,req.user);if(!a)return res.status(404).json({message:'Appointment not found or access denied.'});
  if(a.case_id){const existing=await caseAccess(a.case_id,req.user);return res.json({case:existing,created:false});}
  const c=await pool.connect();try{await c.query('BEGIN');await c.query(`SELECT id FROM appointments WHERE id=$1 FOR UPDATE`,[a.id]);const again=(await c.query(`SELECT case_id FROM appointments WHERE id=$1`,[a.id])).rows[0];if(again.case_id){const existing=(await c.query(`SELECT * FROM consultation_cases WHERE id=$1`,[again.case_id])).rows[0];await c.query('COMMIT');return res.json({case:existing,created:false});}
    const title=String(req.body?.title||`${a.workflow_key==='MEDICAL'?'Care':a.workflow_key==='LEGAL'?'Matter':a.workflow_key==='TECHNOLOGY'?'Engagement':'Consultation'}: ${a.service_name}`).slice(0,255);
    const cc=(await c.query(`INSERT INTO consultation_cases(case_reference,client_user_id,category_id,workflow_key,title,summary,originating_provider_id,current_provider_id) VALUES($1,$2,$3,$4,$5,$6,$7,$7) RETURNING *`,[reference('CASE'),a.client_user_id,a.category_id,a.workflow_key,title,req.body?.summary||null,a.provider_id])).rows[0];
    await c.query(`UPDATE appointments SET case_id=$2 WHERE id=$1`,[a.id,cc.id]);
    await c.query(`UPDATE secure_documents SET case_id=$2 WHERE appointment_id=$1 AND case_id IS NULL`,[a.id,cc.id]);
    await c.query(`INSERT INTO case_provider_access(case_id,provider_id,access_level,granted_by_user_id) VALUES($1,$2,'ORIGINATING',$3) ON CONFLICT(case_id,provider_id) DO NOTHING`,[cc.id,a.provider_id,a.client_user_id]);
    await audit({actorUserId:req.user.sub,eventType:'CONSULTATION_CASE_CREATED',entityType:'CASE',entityId:cc.id,action:'CREATE',afterState:{workflowKey:cc.workflow_key,appointmentId:a.id},req,client:c});
    await c.query('COMMIT');res.status(201).json({case:cc,created:true});
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}));

router.post('/:caseId/appointments/:appointmentId',asyncRoute(async(req,res)=>{
  const cc=await caseAccess(req.params.caseId,req.user);if(!cc)return res.status(404).json({message:'Case not found or access denied.'});const a=await appointmentParticipant(req.params.appointmentId,req.user);if(!a)return res.status(404).json({message:'Appointment not found or access denied.'});if(a.client_user_id!==cc.client_user_id)return res.status(409).json({message:'Appointment belongs to a different client.'});if(a.workflow_key!==cc.workflow_key)return res.status(409).json({message:'Appointment workflow does not match this case.'});await pool.query(`UPDATE appointments SET case_id=$2 WHERE id=$1`,[a.id,cc.id]);await pool.query(`UPDATE secure_documents SET case_id=$2 WHERE appointment_id=$1 AND case_id IS NULL`,[a.id,cc.id]);await audit({actorUserId:req.user.sub,eventType:'APPOINTMENT_LINKED_TO_CASE',entityType:'CASE',entityId:cc.id,action:'LINK',afterState:{appointmentId:a.id},req});res.json({message:'Appointment linked to case.'});
}));

router.get('/mine',asyncRoute(async(req,res)=>{
  if(req.user.role==='CLIENT'){
    const r=await pool.query(`SELECT c.*,sc.name category_name,pu.first_name current_provider_first_name,pu.last_name current_provider_last_name
      FROM consultation_cases c LEFT JOIN service_categories sc ON sc.id=c.category_id JOIN provider_profiles p ON p.id=c.current_provider_id JOIN users pu ON pu.id=p.user_id WHERE c.client_user_id=$1 ORDER BY c.updated_at DESC`,[req.user.sub]);return res.json({cases:r.rows});
  }
  if(req.user.role==='PROVIDER'){
    const p=await providerForUser(req.user.sub);if(!p)return res.json({cases:[]});const r=await pool.query(`SELECT DISTINCT c.*,sc.name category_name,cu.first_name client_first_name,cu.last_name client_last_name,
      CASE WHEN c.current_provider_id=$1 THEN 'CURRENT' WHEN c.originating_provider_id=$1 THEN 'ORIGINATING' ELSE 'READ_ONLY' END access_role
      FROM consultation_cases c LEFT JOIN service_categories sc ON sc.id=c.category_id JOIN users cu ON cu.id=c.client_user_id LEFT JOIN case_provider_access a ON a.case_id=c.id AND a.provider_id=$1 AND a.revoked_at IS NULL AND (a.valid_until IS NULL OR a.valid_until>NOW())
      WHERE c.current_provider_id=$1 OR c.originating_provider_id=$1 OR a.id IS NOT NULL ORDER BY c.updated_at DESC`,[p.id]);return res.json({cases:r.rows});
  }
  res.json({cases:[]});
}));

router.get('/appointments/:appointmentId/history',authorize('PROVIDER'),asyncRoute(async(req,res)=>{
  const current=await appointmentParticipant(req.params.appointmentId,req.user);if(!current)return res.status(404).json({message:'Appointment not found or access denied.'});const p=await providerForUser(req.user.sub);if(!p)return res.status(404).json({message:'Provider profile not found.'});
  // Always show this provider's prior consultations with the same client. Cross-provider records require case access granted by the client.
  const own=await pool.query(`SELECT a.id,a.booking_reference,a.starts_at,a.ends_at,a.status,a.case_id,s.name service_name,COALESCE(aw.workflow_key,'GENERAL') workflow_key,
    pu.first_name provider_first_name,pu.last_name provider_last_name,
    m.assessment medical_assessment,m.plan medical_plan,m.follow_up medical_follow_up,
    lr.advice_summary legal_advice_summary,lr.next_steps legal_next_steps,
    tr.findings technology_findings,tr.recommendations technology_recommendations
    FROM appointments a JOIN provider_services s ON s.id=a.service_id JOIN provider_profiles px ON px.id=a.provider_id JOIN users pu ON pu.id=px.user_id LEFT JOIN appointment_workflows aw ON aw.appointment_id=a.id
    LEFT JOIN medical_consultation_records m ON m.appointment_id=a.id LEFT JOIN legal_matters lm ON lm.appointment_id=a.id LEFT JOIN legal_consultation_records lr ON lr.legal_matter_id=lm.id LEFT JOIN technology_consultation_records tr ON tr.appointment_id=a.id
    WHERE a.client_user_id=$1 AND a.provider_id=$2 AND a.id<>$3 ORDER BY a.starts_at DESC LIMIT 100`,[current.client_user_id,p.id,current.id]);
  let shared=[];let sharedCase=null;
  if(current.case_id){const cc=await caseAccess(current.case_id,req.user);if(cc){sharedCase=cc;const ar=await pool.query(`SELECT scope FROM case_provider_access WHERE case_id=$1 AND provider_id=$2 AND revoked_at IS NULL AND (valid_until IS NULL OR valid_until>NOW())`,[cc.id,p.id]);const scope=ar.rows[0]?.scope||((cc.current_provider_id===p.id||cc.originating_provider_id===p.id)?{consultations:true,documents:true,records:true}:{});if(scope.consultations){const q=await pool.query(`SELECT a.id,a.booking_reference,a.starts_at,a.ends_at,a.status,a.case_id,s.name service_name,COALESCE(aw.workflow_key,'GENERAL') workflow_key,pu.first_name provider_first_name,pu.last_name provider_last_name,
        CASE WHEN $2::boolean THEN m.assessment ELSE NULL END medical_assessment,CASE WHEN $2::boolean THEN m.plan ELSE NULL END medical_plan,
        CASE WHEN $2::boolean THEN lr.advice_summary ELSE NULL END legal_advice_summary,CASE WHEN $2::boolean THEN lr.next_steps ELSE NULL END legal_next_steps,
        CASE WHEN $2::boolean THEN tr.findings ELSE NULL END technology_findings,CASE WHEN $2::boolean THEN tr.recommendations ELSE NULL END technology_recommendations
        FROM appointments a JOIN provider_services s ON s.id=a.service_id JOIN provider_profiles px ON px.id=a.provider_id JOIN users pu ON pu.id=px.user_id LEFT JOIN appointment_workflows aw ON aw.appointment_id=a.id LEFT JOIN medical_consultation_records m ON m.appointment_id=a.id LEFT JOIN legal_matters lm ON lm.appointment_id=a.id LEFT JOIN legal_consultation_records lr ON lr.legal_matter_id=lm.id LEFT JOIN technology_consultation_records tr ON tr.appointment_id=a.id
        WHERE a.case_id=$1 AND a.id<>$3 ORDER BY a.starts_at DESC`,[cc.id,Boolean(scope.records),current.id]);shared=q.rows;}}}
  const merged=[...own,...shared.filter(x=>!own.some(o=>o.id===x.id))].sort((a,b)=>new Date(b.starts_at)-new Date(a.starts_at));res.json({client:{id:current.client_user_id},case:sharedCase,appointments:merged});
}));

router.get('/:caseId',asyncRoute(async(req,res)=>{
  const cc=await caseAccess(req.params.caseId,req.user);if(!cc)return res.status(404).json({message:'Case not found or access denied.'});const p=req.user.role==='PROVIDER'?await providerForUser(req.user.sub):null;let scope={consultations:true,documents:true,records:true};if(p&&![cc.current_provider_id,cc.originating_provider_id].includes(p.id)){const r=await pool.query(`SELECT scope FROM case_provider_access WHERE case_id=$1 AND provider_id=$2 AND revoked_at IS NULL AND (valid_until IS NULL OR valid_until>NOW())`,[cc.id,p.id]);scope=r.rows[0]?.scope||{};}
  const appointments=scope.consultations===false?[]:(await pool.query(`SELECT a.id,a.booking_reference,a.starts_at,a.ends_at,a.status,s.name service_name,COALESCE(aw.workflow_key,'GENERAL') workflow_key,pu.first_name provider_first_name,pu.last_name provider_last_name,
    CASE WHEN $2::boolean THEN m.assessment ELSE NULL END medical_assessment,CASE WHEN $2::boolean THEN m.plan ELSE NULL END medical_plan,
    CASE WHEN $2::boolean THEN lr.advice_summary ELSE NULL END legal_advice_summary,CASE WHEN $2::boolean THEN lr.next_steps ELSE NULL END legal_next_steps,
    CASE WHEN $2::boolean THEN tr.findings ELSE NULL END technology_findings,CASE WHEN $2::boolean THEN tr.recommendations ELSE NULL END technology_recommendations
    FROM appointments a JOIN provider_services s ON s.id=a.service_id JOIN provider_profiles px ON px.id=a.provider_id JOIN users pu ON pu.id=px.user_id LEFT JOIN appointment_workflows aw ON aw.appointment_id=a.id
    LEFT JOIN medical_consultation_records m ON m.appointment_id=a.id LEFT JOIN legal_matters lm ON lm.appointment_id=a.id LEFT JOIN legal_consultation_records lr ON lr.legal_matter_id=lm.id LEFT JOIN technology_consultation_records tr ON tr.appointment_id=a.id
    WHERE a.case_id=$1 ORDER BY a.starts_at DESC`,[cc.id,scope.records!==false])).rows;
  const handovers=(await pool.query(`SELECT h.*,fu.first_name from_first_name,fu.last_name from_last_name,tu.first_name to_first_name,tu.last_name to_last_name FROM case_handover_requests h JOIN provider_profiles fp ON fp.id=h.from_provider_id JOIN users fu ON fu.id=fp.user_id JOIN provider_profiles tp ON tp.id=h.to_provider_id JOIN users tu ON tu.id=tp.user_id WHERE h.case_id=$1 ORDER BY h.created_at DESC`,[cc.id])).rows;
  res.json({case:cc,scope,appointments,handovers});
}));

router.post('/:caseId/handover',asyncRoute(async(req,res)=>{
  const cc=await caseAccess(req.params.caseId,req.user);if(!cc)return res.status(404).json({message:'Case not found or access denied.'});if(!['CLIENT','PROVIDER'].includes(req.user.role))return res.status(403).json({message:'Only the client or a case provider can request a handover.'});
  let fromProvider=cc.current_provider_id;if(req.user.role==='PROVIDER'){const p=await providerForUser(req.user.sub);if(!p||![cc.current_provider_id,cc.originating_provider_id].includes(p.id))return res.status(403).json({message:'Only the current/originating provider can initiate a handover.'});fromProvider=p.id;}
  let target;if(req.body?.toProviderId)target=(await pool.query(`SELECT p.*,u.first_name,u.last_name,u.email,COALESCE(w.workflow_key,'GENERAL') workflow_key FROM provider_profiles p JOIN users u ON u.id=p.user_id LEFT JOIN service_category_workflows w ON w.category_id=p.category_id WHERE p.id=$1 AND p.verification_status='VERIFIED' AND u.is_active=TRUE`,[req.body.toProviderId])).rows[0];else if(req.body?.toProviderEmail)target=(await pool.query(`SELECT p.*,u.first_name,u.last_name,u.email,COALESCE(w.workflow_key,'GENERAL') workflow_key FROM provider_profiles p JOIN users u ON u.id=p.user_id LEFT JOIN service_category_workflows w ON w.category_id=p.category_id WHERE LOWER(u.email)=LOWER($1) AND p.verification_status='VERIFIED' AND u.is_active=TRUE`,[req.body.toProviderEmail])).rows[0];if(!target)return res.status(404).json({message:'Target provider not found or is not verified.'});if(target.workflow_key!==cc.workflow_key)return res.status(409).json({message:'The successor provider must support the same case workflow/category.'});if(target.id===fromProvider)return res.status(409).json({message:'Target provider is already handling the case.'});
  const r=(await pool.query(`INSERT INTO case_handover_requests(case_id,from_provider_id,to_provider_id,requested_by_user_id,reason,scope) VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`,[cc.id,fromProvider,target.id,req.user.sub,req.body?.reason||null,JSON.stringify(req.body?.scope||{consultations:true,documents:true,records:true})])).rows[0];
  await notify({userId:cc.client_user_id,type:'CASE_HANDOVER_APPROVAL',title:'Case handover approval required',message:`A handover of ${cc.case_reference} to ${target.first_name} ${target.last_name} is waiting for your approval.`,relatedType:'CASE_HANDOVER',relatedId:r.id});await audit({actorUserId:req.user.sub,eventType:'CASE_HANDOVER_REQUESTED',entityType:'CASE',entityId:cc.id,action:'REQUEST',afterState:{handoverId:r.id,toProviderId:target.id},req});res.status(201).json({handover:r});
}));

router.get('/handovers/mine/list',asyncRoute(async(req,res)=>{
  if(req.user.role==='CLIENT'){const r=await pool.query(`SELECT h.*,c.case_reference,c.title,fu.first_name from_first_name,fu.last_name from_last_name,tu.first_name to_first_name,tu.last_name to_last_name FROM case_handover_requests h JOIN consultation_cases c ON c.id=h.case_id JOIN provider_profiles fp ON fp.id=h.from_provider_id JOIN users fu ON fu.id=fp.user_id JOIN provider_profiles tp ON tp.id=h.to_provider_id JOIN users tu ON tu.id=tp.user_id WHERE c.client_user_id=$1 ORDER BY h.created_at DESC`,[req.user.sub]);return res.json({handovers:r.rows});}
  if(req.user.role==='PROVIDER'){const p=await providerForUser(req.user.sub);if(!p)return res.json({handovers:[]});const r=await pool.query(`SELECT h.*,c.case_reference,c.title,cu.first_name client_first_name,cu.last_name client_last_name FROM case_handover_requests h JOIN consultation_cases c ON c.id=h.case_id JOIN users cu ON cu.id=c.client_user_id WHERE h.from_provider_id=$1 OR h.to_provider_id=$1 ORDER BY h.created_at DESC`,[p.id]);return res.json({handovers:r.rows});}res.json({handovers:[]});
}));

router.post('/handovers/:handoverId/decision',authorize('CLIENT'),asyncRoute(async(req,res)=>{
  const decision=String(req.body?.decision||'').toUpperCase();if(!['APPROVE','REJECT'].includes(decision))return res.status(400).json({message:'decision must be APPROVE or REJECT.'});const c=await pool.connect();try{await c.query('BEGIN');const h=(await c.query(`SELECT h.*,cc.client_user_id,cc.current_provider_id FROM case_handover_requests h JOIN consultation_cases cc ON cc.id=h.case_id WHERE h.id=$1 FOR UPDATE`,[req.params.handoverId])).rows[0];if(!h||h.client_user_id!==req.user.sub){await c.query('ROLLBACK');return res.status(404).json({message:'Handover request not found.'});}if(h.status!=='PENDING_CLIENT'||new Date(h.expires_at)<=new Date()){await c.query('ROLLBACK');return res.status(409).json({message:'This handover request is no longer awaiting a decision.'});}
    const status=decision==='APPROVE'?'APPROVED':'REJECTED';await c.query(`UPDATE case_handover_requests SET status=$2,client_decision_at=NOW(),client_decision_notes=$3 WHERE id=$1`,[h.id,status,req.body?.notes||null]);
    if(status==='APPROVED'){
      await c.query(`UPDATE case_provider_access SET access_level=CASE WHEN provider_id=$2 THEN 'READ_ONLY' ELSE access_level END WHERE case_id=$1 AND provider_id=$2`,[h.case_id,h.from_provider_id]);
      await c.query(`INSERT INTO case_provider_access(case_id,provider_id,access_level,scope,granted_by_user_id) VALUES($1,$2,'CURRENT',$3::jsonb,$4) ON CONFLICT(case_id,provider_id) DO UPDATE SET access_level='CURRENT',scope=EXCLUDED.scope,granted_by_user_id=EXCLUDED.granted_by_user_id,granted_at=NOW(),revoked_at=NULL`,[h.case_id,h.to_provider_id,JSON.stringify(h.scope),req.user.sub]);
      await c.query(`UPDATE consultation_cases SET current_provider_id=$2,updated_at=NOW() WHERE id=$1`,[h.case_id,h.to_provider_id]);
    }
    const targetUser=(await c.query(`SELECT user_id FROM provider_profiles WHERE id=$1`,[h.to_provider_id])).rows[0]?.user_id;const fromUser=(await c.query(`SELECT user_id FROM provider_profiles WHERE id=$1`,[h.from_provider_id])).rows[0]?.user_id;
    for(const uid of [targetUser,fromUser].filter(Boolean))await notify({userId:uid,type:'CASE_HANDOVER_DECISION',title:`Case handover ${status.toLowerCase()}`,message:`The client ${status==='APPROVED'?'approved':'declined'} the requested case handover.`,relatedType:'CASE_HANDOVER',relatedId:h.id,client:c});await audit({actorUserId:req.user.sub,eventType:'CASE_HANDOVER_DECIDED',entityType:'CASE',entityId:h.case_id,action:decision,afterState:{handoverId:h.id,status},req,client:c});await c.query('COMMIT');res.json({status});
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}));

module.exports=router;
