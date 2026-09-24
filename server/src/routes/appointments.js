const express=require('express');
const pool=require('../db');
const {authenticate,authorize}=require('../auth');
const {getSlots,expireHolds,getSettings}=require('../calendar/service');
const {notify}=require('../services/notifications');
const {reference}=require('../services/helpers');
const {ensureAppointmentWorkflow}=require('../workflows/service');
const {recordRefund}=require('../billing/service');
const {audit}=require('../services/audit');
const router=express.Router(); const asyncRoute=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);

async function appointmentDetail(id,userId,role,client=pool){
  const ownership=role==='ADMIN'?'TRUE':role==='PROVIDER'?`p.user_id=$2`:`a.client_user_id=$2`;
  const r=await client.query(
    `SELECT a.*,s.name service_name,s.price::float,s.currency,s.duration_minutes,
      cu.first_name client_first_name,cu.last_name client_last_name,pu.first_name provider_first_name,pu.last_name provider_last_name,p.profession,p.user_id provider_user_id,
      pay.id payment_id,pay.payment_reference,pay.status payment_record_status,cr.id room_id,cr.room_code,cr.status room_status
     FROM appointments a JOIN provider_profiles p ON p.id=a.provider_id JOIN provider_services s ON s.id=a.service_id
     JOIN users cu ON cu.id=a.client_user_id JOIN users pu ON pu.id=p.user_id
     LEFT JOIN LATERAL(SELECT * FROM payments x WHERE x.appointment_id=a.id ORDER BY x.created_at DESC LIMIT 1) pay ON TRUE
     LEFT JOIN consultation_rooms cr ON cr.appointment_id=a.id
     WHERE a.id=$1 AND ${ownership}`,[id,userId]);return r.rows[0]||null;
}

router.get('/mine',authenticate,asyncRoute(async(req,res)=>{
  await expireHolds();
  let clause,params=[req.user.sub];
  if(req.user.role==='PROVIDER') clause=`p.user_id=$1`; else if(req.user.role==='ADMIN') {clause='TRUE';params=[];} else clause=`a.client_user_id=$1`;
  const r=await pool.query(
    `SELECT a.*,s.name service_name,s.price::float,s.currency,cu.first_name client_first_name,cu.last_name client_last_name,
      pu.first_name provider_first_name,pu.last_name provider_last_name,p.profession,p.user_id provider_user_id,
      pay.payment_reference,pay.status payment_record_status,cr.id room_id,cr.status room_status,
      rv.id review_id,rv.rating review_rating,rv.review_text,rv.moderation_status review_moderation_status
     FROM appointments a JOIN provider_profiles p ON p.id=a.provider_id JOIN provider_services s ON s.id=a.service_id
     JOIN users cu ON cu.id=a.client_user_id JOIN users pu ON pu.id=p.user_id
     LEFT JOIN LATERAL(SELECT * FROM payments x WHERE x.appointment_id=a.id ORDER BY x.created_at DESC LIMIT 1) pay ON TRUE
     LEFT JOIN consultation_rooms cr ON cr.appointment_id=a.id
     LEFT JOIN reviews rv ON rv.appointment_id=a.id
     WHERE ${clause} ORDER BY a.starts_at DESC LIMIT 250`,params);res.json({appointments:r.rows});
}));

router.post('/',authenticate,authorize('CLIENT'),asyncRoute(async(req,res)=>{
  const {providerId,serviceId,startsAt,clientNotes,idempotencyKey}=req.body;
  if(!providerId||!serviceId||!startsAt)return res.status(400).json({message:'providerId, serviceId and startsAt are required.'});
  if(idempotencyKey){const existing=await pool.query(`SELECT id FROM appointments WHERE client_user_id=$1 AND idempotency_key=$2`,[req.user.sub,idempotencyKey]);if(existing.rowCount)return res.json({appointment:await appointmentDetail(existing.rows[0].id,req.user.sub,'CLIENT'),idempotent:true});}
  const start=new Date(startsAt);if(Number.isNaN(start.getTime()))return res.status(400).json({message:'Invalid appointment start.'});
  const date=start.toISOString().slice(0,10);const available=await getSlots({providerId,date,serviceId});
  if(!available.slots?.includes(start.toISOString()))return res.status(409).json({message:'That slot is no longer available. Refresh availability and choose another time.'});
  const service=(await pool.query(`SELECT s.*,p.verification_status,p.user_id provider_user_id FROM provider_services s JOIN provider_profiles p ON p.id=s.provider_id WHERE s.id=$1 AND s.provider_id=$2 AND s.is_active=TRUE`,[serviceId,providerId])).rows[0];
  if(!service||service.verification_status!=='VERIFIED')return res.status(403).json({message:'This professional is not currently approved for bookings.'});
  const end=new Date(start.getTime()+Number(service.duration_minutes)*60000);const bookingRef=reference('CH');
  const c=await pool.connect();try{
    await c.query('BEGIN');await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[providerId]);await expireHolds(c);
    const conflict=await c.query(`SELECT 1 FROM appointments WHERE provider_id=$1 AND (status='CONFIRMED' OR (status='PENDING' AND hold_expires_at>NOW())) AND starts_at<$3 AND ends_at>$2 LIMIT 1`,[providerId,start,end]);
    if(conflict.rowCount){await c.query('ROLLBACK');return res.status(409).json({message:'That slot was just reserved by someone else.'});}
    const a=(await c.query(
      `INSERT INTO appointments(client_user_id,provider_id,service_id,starts_at,ends_at,status,client_notes,payment_status,hold_expires_at,booking_reference,idempotency_key)
       VALUES($1,$2,$3,$4,$5,'PENDING',$6,'PENDING',NOW()+INTERVAL '10 minutes',$7,$8) RETURNING *`,
      [req.user.sub,providerId,serviceId,start,end,clientNotes||null,bookingRef,idempotencyKey||null])).rows[0];
    const pay=(await c.query(`INSERT INTO payments(appointment_id,client_user_id,provider_id,payment_reference,amount,currency,status,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,'PENDING',$7) RETURNING *`,[a.id,req.user.sub,providerId,reference('PAY'),service.price,service.currency,idempotencyKey?`PAY-${idempotencyKey}`:null])).rows[0];
    const workflow=await ensureAppointmentWorkflow(a.id,providerId,c);
    await notify({userId:req.user.sub,type:'BOOKING_HELD',title:'Appointment held for payment',message:`${bookingRef} is reserved for 10 minutes. Complete the demo payment to confirm it.`,relatedType:'APPOINTMENT',relatedId:a.id,client:c});
    await notify({userId:service.provider_user_id,type:'BOOKING_HELD',title:'New appointment awaiting payment',message:`A client reserved ${bookingRef}. The appointment confirms after payment.`,relatedType:'APPOINTMENT',relatedId:a.id,client:c});
    await audit({actorUserId:req.user.sub,eventType:'APPOINTMENT_RESERVED',entityType:'APPOINTMENT',entityId:a.id,action:'CREATE',afterState:{bookingReference:bookingRef,workflow:workflow.workflow_key},req,client:c});
    await c.query('COMMIT');res.status(201).json({appointment:a,payment:pay,workflow,holdMinutes:10});
  }catch(e){await c.query('ROLLBACK');if(['23505','23P01'].includes(e.code))return res.status(409).json({message:'That slot is no longer available.'});throw e;}finally{c.release();}
}));

router.patch('/:id/status',authenticate,asyncRoute(async(req,res)=>{
  const status=String(req.body.status||'').toUpperCase();if(!['CANCELLED','COMPLETED'].includes(status))return res.status(400).json({message:'Only CANCELLED or COMPLETED can be set here.'});
  const a=await appointmentDetail(req.params.id,req.user.sub,req.user.role);if(!a)return res.status(404).json({message:'Appointment not found.'});
  if(status==='COMPLETED'&&req.user.role!=='PROVIDER')return res.status(403).json({message:'Only the provider can complete the appointment.'});
  if(status==='CANCELLED'){
    const settings=await getSettings(a.provider_id);const hours=(new Date(a.starts_at)-new Date())/3600000;
    if(req.user.role==='CLIENT'&&hours<Number(settings.cancellation_notice_hours))return res.status(409).json({message:`Online cancellation closes ${settings.cancellation_notice_hours} hours before the appointment. Contact support/provider.`});
  }
  const c=await pool.connect();try{await c.query('BEGIN');
    const r=(await c.query(`UPDATE appointments
      SET status=$1,
          cancellation_reason=CASE WHEN $1='CANCELLED' THEN $2 ELSE cancellation_reason END,
          cancelled_by=CASE WHEN $1='CANCELLED' THEN $3 ELSE cancelled_by END,
          completed_at=CASE WHEN $1='COMPLETED' THEN COALESCE(completed_at,NOW()) ELSE completed_at END,
          updated_at=NOW()
      WHERE id=$4
      RETURNING *`,[status,req.body.reason||null,req.user.sub,a.id])).rows[0];
    if(status==='CANCELLED'&&a.payment_status==='PAID'){
      const pay=(await c.query(`UPDATE payments SET status='REFUNDED',refunded_at=NOW(),updated_at=NOW() WHERE appointment_id=$1 AND status='PAID' RETURNING *`,[a.id])).rows[0];
      await c.query(`UPDATE appointments SET payment_status='REFUNDED' WHERE id=$1`,[a.id]);
      if(pay)await recordRefund({payment:pay,appointment:a,reason:req.body.reason||'Appointment cancellation',requestedBy:req.user.sub,client:c});
    }
    await notify({userId:a.client_user_id,type:`APPOINTMENT_${status}`,title:`Appointment ${status.toLowerCase()}`,message:`Booking ${a.booking_reference||a.id} is now ${status.toLowerCase()}.`,relatedType:'APPOINTMENT',relatedId:a.id,client:c});
    await notify({userId:a.provider_user_id,type:`APPOINTMENT_${status}`,title:`Appointment ${status.toLowerCase()}`,message:`Booking ${a.booking_reference||a.id} is now ${status.toLowerCase()}.`,relatedType:'APPOINTMENT',relatedId:a.id,client:c});
    if(status==='COMPLETED')await c.query(`UPDATE consultation_rooms SET status='CLOSED',closed_at=NOW() WHERE appointment_id=$1`,[a.id]);
    await c.query('COMMIT');res.json({appointment:r});
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}));

router.post('/:id/reschedule',authenticate,asyncRoute(async(req,res)=>{
  if(!['CLIENT','PROVIDER'].includes(req.user.role))return res.status(403).json({message:'Not allowed.'});
  const a=await appointmentDetail(req.params.id,req.user.sub,req.user.role);if(!a)return res.status(404).json({message:'Appointment not found.'});
  if(!['PENDING','CONFIRMED'].includes(a.status))return res.status(409).json({message:'Only active appointments can be rescheduled.'});
  const start=new Date(req.body.startsAt);if(Number.isNaN(start.getTime()))return res.status(400).json({message:'Valid startsAt required.'});
  const slots=await getSlots({providerId:a.provider_id,date:start.toISOString().slice(0,10),serviceId:a.service_id});if(!slots.slots?.includes(start.toISOString()))return res.status(409).json({message:'Requested time is not available.'});
  const end=new Date(start.getTime()+Number(a.duration_minutes)*60000);const c=await pool.connect();try{await c.query('BEGIN');await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[a.provider_id]);
    const r=(await c.query(`UPDATE appointments SET starts_at=$1,ends_at=$2,updated_at=NOW(),hold_expires_at=CASE WHEN status='PENDING' THEN NOW()+INTERVAL '10 minutes' ELSE hold_expires_at END WHERE id=$3 RETURNING *`,[start,end,a.id])).rows[0];
    await c.query(`UPDATE consultation_rooms SET opens_at=$2::timestamptz - INTERVAL '15 minutes',closes_at=$3::timestamptz + INTERVAL '30 minutes' WHERE appointment_id=$1`,[a.id,start,end]);
    await notify({userId:a.client_user_id,type:'APPOINTMENT_RESCHEDULED',title:'Appointment rescheduled',message:`Your appointment moved to ${start.toLocaleString('en-ZA')}.`,relatedType:'APPOINTMENT',relatedId:a.id,client:c});
    await notify({userId:a.provider_user_id,type:'APPOINTMENT_RESCHEDULED',title:'Appointment rescheduled',message:`An appointment moved to ${start.toLocaleString('en-ZA')}.`,relatedType:'APPOINTMENT',relatedId:a.id,client:c});
    await c.query('COMMIT');res.json({appointment:r});
  }catch(e){await c.query('ROLLBACK');if(e.code==='23P01')return res.status(409).json({message:'Requested time overlaps another appointment.'});throw e;}finally{c.release();}
}));

router.post('/:id/no-show',authenticate,asyncRoute(async(req,res)=>{
  const a=await appointmentDetail(req.params.id,req.user.sub,req.user.role);if(!a)return res.status(404).json({message:'Appointment not found.'});
  if(!['PROVIDER','CLIENT','ADMIN'].includes(req.user.role))return res.status(403).json({message:'Not allowed.'});
  if(!['CONFIRMED','NO_SHOW'].includes(a.status))return res.status(409).json({message:'Only confirmed appointments can be marked as no-show.'});
  const party=req.user.role==='PROVIDER'?'CLIENT':req.user.role==='CLIENT'?'PROVIDER':String(req.body.party||'CLIENT').toUpperCase();
  if(!['CLIENT','PROVIDER','BOTH'].includes(party))return res.status(400).json({message:'party must be CLIENT, PROVIDER or BOTH.'});
  const r=(await pool.query(`UPDATE appointments SET status='NO_SHOW',no_show_by=$2,no_show_recorded_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *`,[a.id,party])).rows[0];
  await audit({actorUserId:req.user.sub,eventType:'APPOINTMENT_NO_SHOW',entityType:'APPOINTMENT',entityId:a.id,action:'UPDATE',afterState:{noShowBy:party},req});res.json({appointment:r});
}));

router.post('/waiting-list',authenticate,authorize('CLIENT'),asyncRoute(async(req,res)=>{
  const {providerId,serviceId,preferredDate,preferredWindow}=req.body;if(!providerId||!serviceId)return res.status(400).json({message:'providerId and serviceId are required.'});
  const s=await pool.query(`SELECT 1 FROM provider_services WHERE id=$1 AND provider_id=$2 AND is_active=TRUE`,[serviceId,providerId]);if(!s.rowCount)return res.status(400).json({message:'Invalid provider service.'});
  const r=(await pool.query(`INSERT INTO waiting_list_entries(client_user_id,provider_id,service_id,preferred_date,preferred_window) VALUES($1,$2,$3,$4,$5) RETURNING *`,[req.user.sub,providerId,serviceId,preferredDate||null,preferredWindow||null])).rows[0];
  res.status(201).json({waitingListEntry:r});
}));

router.get('/waiting-list/mine',authenticate,asyncRoute(async(req,res)=>{
  let q,params=[req.user.sub];if(req.user.role==='PROVIDER')q=`SELECT w.*,u.first_name client_first_name,u.last_name client_last_name,s.name service_name FROM waiting_list_entries w JOIN provider_profiles p ON p.id=w.provider_id JOIN users u ON u.id=w.client_user_id JOIN provider_services s ON s.id=w.service_id WHERE p.user_id=$1 ORDER BY w.created_at DESC`;else q=`SELECT w.*,p.profession,s.name service_name FROM waiting_list_entries w JOIN provider_profiles p ON p.id=w.provider_id JOIN provider_services s ON s.id=w.service_id WHERE w.client_user_id=$1 ORDER BY w.created_at DESC`;
  const r=await pool.query(q,params);res.json({entries:r.rows});
}));

router.post('/recurring-series',authenticate,authorize('CLIENT'),asyncRoute(async(req,res)=>{
  const {providerId,serviceId,recurrenceRule}=req.body;if(!providerId||!serviceId||!recurrenceRule)return res.status(400).json({message:'providerId, serviceId and recurrenceRule are required.'});
  const s=await pool.query(`SELECT 1 FROM provider_services WHERE id=$1 AND provider_id=$2 AND is_active=TRUE`,[serviceId,providerId]);if(!s.rowCount)return res.status(400).json({message:'Invalid provider service.'});
  const r=(await pool.query(`INSERT INTO recurring_booking_series(client_user_id,provider_id,service_id,recurrence_rule) VALUES($1,$2,$3,$4) RETURNING *`,[req.user.sub,providerId,serviceId,recurrenceRule])).rows[0];
  res.status(201).json({series:r,message:'Recurring series created. Occurrences remain subject to provider availability and payment.'});
}));

module.exports=router;
