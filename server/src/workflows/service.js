const pool=require('../db');
const {workflowDefaults,roomAccessAllowed}=require('../services/domain-rules');

async function workflowForProvider(providerId,client=pool){
  const r=await client.query(`SELECT COALESCE(w.workflow_key,'GENERAL') workflow_key,c.slug,c.name
    FROM provider_profiles p LEFT JOIN service_categories c ON c.id=p.category_id
    LEFT JOIN service_category_workflows w ON w.category_id=p.category_id WHERE p.id=$1`,[providerId]);
  return r.rows[0]||{workflow_key:'GENERAL'};
}

async function ensureAppointmentWorkflow(appointmentId,providerId,client=pool){
  const wf=await workflowForProvider(providerId,client);const d=workflowDefaults(wf.workflow_key);
  const room=d.intake==='NOT_REQUIRED'&&d.clearance==='NOT_REQUIRED'?'ALLOWED':'BLOCKED';
  const r=await client.query(`INSERT INTO appointment_workflows(appointment_id,workflow_key,intake_status,provider_clearance_status,room_access_status)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(appointment_id) DO NOTHING RETURNING *`,[appointmentId,wf.workflow_key,d.intake,d.clearance,room]);
  if(r.rowCount)return r.rows[0];
  return (await client.query(`SELECT * FROM appointment_workflows WHERE appointment_id=$1`,[appointmentId])).rows[0];
}

async function recomputeRoomAccess(appointmentId,client=pool){
  const r=await client.query(`SELECT * FROM appointment_workflows WHERE appointment_id=$1`,[appointmentId]);if(!r.rowCount)return null;
  const w=r.rows[0];
  const allowed=roomAccessAllowed({intakeStatus:w.intake_status,providerClearanceStatus:w.provider_clearance_status});
  return (await client.query(`UPDATE appointment_workflows SET room_access_status=$2,updated_at=NOW() WHERE appointment_id=$1 RETURNING *`,[appointmentId,allowed?'ALLOWED':'BLOCKED'])).rows[0];
}

async function canAccessAppointment(appointmentId,userId,role,client=pool){
  const r=await client.query(`SELECT a.*,p.user_id provider_user_id,p.id provider_id,c.slug category_slug,c.name category_name,
    COALESCE(w.workflow_key,'GENERAL') workflow_key,w.intake_status,w.provider_clearance_status,w.room_access_status
    FROM appointments a JOIN provider_profiles p ON p.id=a.provider_id JOIN provider_services s ON s.id=a.service_id
    LEFT JOIN service_categories c ON c.id=p.category_id LEFT JOIN appointment_workflows w ON w.appointment_id=a.id
    WHERE a.id=$1`,[appointmentId]);
  if(!r.rowCount)return null;const row=r.rows[0];
  if(role!=='ADMIN'&&row.client_user_id!==userId&&row.provider_user_id!==userId)return null;
  return row;
}
module.exports={workflowForProvider,ensureAppointmentWorkflow,recomputeRoomAccess,canAccessAppointment};
