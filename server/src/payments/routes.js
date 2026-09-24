const express=require('express');
const pool=require('../db');
const {authenticate,authorize}=require('../auth');
const {notify}=require('../services/notifications');
const {reference}=require('../services/helpers');
const {expireHolds}=require('../calendar/service');
const {recordPaid}=require('../billing/service');
const {audit}=require('../services/audit');
const {ensureConsultationRoom}=require('../consultations/service');
const router=express.Router();const asyncRoute=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
router.get('/mine',authenticate,asyncRoute(async(req,res)=>{
  let clause,params=[req.user.sub];
  if(req.user.role==='PROVIDER')clause=`p.user_id=$1`;else if(req.user.role==='ADMIN'){clause='TRUE';params=[];}else clause=`pay.client_user_id=$1`;
  const r=await pool.query(`SELECT pay.*,a.booking_reference,a.starts_at,a.status appointment_status,s.name service_name,pu.first_name provider_first_name,pu.last_name provider_last_name
    FROM payments pay JOIN appointments a ON a.id=pay.appointment_id JOIN provider_profiles p ON p.id=pay.provider_id JOIN users pu ON pu.id=p.user_id JOIN provider_services s ON s.id=a.service_id
    WHERE ${clause} ORDER BY pay.created_at DESC LIMIT 200`,params);res.json({payments:r.rows});
}));
router.post('/:appointmentId/demo-pay',authenticate,authorize('CLIENT'),asyncRoute(async(req,res)=>{
  await expireHolds();const c=await pool.connect();try{await c.query('BEGIN');
    const ar=await c.query(`SELECT a.*,p.user_id provider_user_id,s.name service_name FROM appointments a JOIN provider_profiles p ON p.id=a.provider_id JOIN provider_services s ON s.id=a.service_id WHERE a.id=$1 AND a.client_user_id=$2 FOR UPDATE`,[req.params.appointmentId,req.user.sub]);
    if(!ar.rowCount){await c.query('ROLLBACK');return res.status(404).json({message:'Appointment not found.'});}const a=ar.rows[0];
    if(a.status==='EXPIRED'){await c.query('ROLLBACK');return res.status(409).json({message:'The booking hold expired. Please choose the slot again.'});}
    if(a.status==='CONFIRMED'&&a.payment_status==='PAID'){
      const room=await ensureConsultationRoom({appointmentId:a.id,startsAt:a.starts_at,endsAt:a.ends_at,client:c});
      await c.query('COMMIT');
      return res.json({message:'Appointment is already paid and confirmed. Consultation room is ready.',room});
    }
    if(a.status!=='PENDING'){await c.query('ROLLBACK');return res.status(409).json({message:'This appointment cannot be paid.'});}
    const pay=await c.query(`SELECT * FROM payments WHERE appointment_id=$1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,[a.id]);if(!pay.rowCount){await c.query('ROLLBACK');return res.status(404).json({message:'Payment record not found.'});}
    const shouldFail=String(req.body.simulate||'SUCCESS').toUpperCase()==='FAIL';
    if(shouldFail){const p=(await c.query(`UPDATE payments SET status='FAILED',updated_at=NOW(),metadata=metadata||'{"demoFailure":true}'::jsonb WHERE id=$1 RETURNING *`,[pay.rows[0].id])).rows[0];await c.query(`INSERT INTO payment_events(payment_id,event_type,payload) VALUES($1,'PAYMENT_FAILED','{"demo":true}'::jsonb)`,[p.id]);await c.query(`UPDATE appointments SET payment_status='FAILED',updated_at=NOW() WHERE id=$1`,[a.id]);await notify({userId:req.user.sub,type:'PAYMENT_FAILED',title:'Demo payment failed',message:'The simulated payment failed. Your slot remains held until the timer expires.',relatedType:'APPOINTMENT',relatedId:a.id,client:c});await c.query('COMMIT');return res.status(402).json({message:'Demo payment failed as requested.',payment:p});}
    let p=(await c.query(`UPDATE payments SET status='PAID',paid_at=NOW(),updated_at=NOW(),metadata=metadata||$2::jsonb WHERE id=$1 RETURNING *`,[pay.rows[0].id,JSON.stringify({demo:true,approvalCode:reference('APPROVED')})])).rows[0];
    const confirmed=(await c.query(`UPDATE appointments SET status='CONFIRMED',payment_status='PAID',confirmed_at=NOW(),hold_expires_at=NULL,updated_at=NOW() WHERE id=$1 RETURNING *`,[a.id])).rows[0];
    p=await recordPaid({payment:p,appointment:confirmed,serviceName:a.service_name,client:c});
    await ensureConsultationRoom({appointmentId:a.id,startsAt:a.starts_at,endsAt:a.ends_at,client:c});
    await notify({userId:req.user.sub,type:'PAYMENT_CONFIRMED',title:'Payment successful',message:`${a.booking_reference} is confirmed. Your consultation room will open 15 minutes before the appointment.`,relatedType:'APPOINTMENT',relatedId:a.id,client:c});
    await notify({userId:a.provider_user_id,type:'APPOINTMENT_CONFIRMED',title:'Appointment confirmed',message:`${a.booking_reference} has been paid and confirmed.`,relatedType:'APPOINTMENT',relatedId:a.id,client:c});
    await audit({actorUserId:req.user.sub,eventType:'PAYMENT_CONFIRMED',entityType:'PAYMENT',entityId:p.id,action:'PAY',afterState:{amount:p.amount,platformFee:p.platform_fee_amount,providerNet:p.provider_net_amount},req,client:c});
    await c.query('COMMIT');res.json({payment:p,appointment:confirmed,message:'Demo payment successful.'});
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}));
module.exports=router;
