const express=require('express');
const pool=require('../db');
const {authenticate,authorize}=require('../auth');
const {getSettings}=require('./service');
const router=express.Router();
const asyncRoute=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
async function provider(req,res){
  const r=await pool.query(`SELECT * FROM provider_profiles WHERE user_id=$1`,[req.user.sub]);
  if(!r.rowCount){res.status(404).json({message:'Provider profile not found.'});return null;} return r.rows[0];
}
router.use(authenticate,authorize('PROVIDER'));
router.get('/',asyncRoute(async(req,res)=>{
  const p=await provider(req,res);if(!p)return;
  const [settings,availability,blocks]=await Promise.all([
    getSettings(p.id),
    pool.query(`SELECT * FROM provider_availability WHERE provider_id=$1 ORDER BY day_of_week,start_time`,[p.id]),
    pool.query(`SELECT * FROM provider_calendar_blocks WHERE provider_id=$1 AND ends_at>NOW()-INTERVAL '7 days' ORDER BY starts_at`,[p.id])
  ]);
  res.json({settings,availability:availability.rows,blocks:blocks.rows});
}));
router.put('/settings',asyncRoute(async(req,res)=>{
  const p=await provider(req,res);if(!p)return;
  const b=req.body;
  const vals={timezone:b.timezone||'Africa/Johannesburg',slot:Number(b.slotIncrementMinutes||15),notice:Number(b.minimumNoticeMinutes||120),advance:Number(b.maximumAdvanceDays||60),before:Number(b.bufferBeforeMinutes||0),after:Number(b.bufferAfterMinutes||10),cancel:Number(b.cancellationNoticeHours||4)};
  const r=await pool.query(
    `INSERT INTO provider_calendar_settings(provider_id,timezone,slot_increment_minutes,minimum_notice_minutes,maximum_advance_days,buffer_before_minutes,buffer_after_minutes,cancellation_notice_hours,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW())
     ON CONFLICT(provider_id) DO UPDATE SET timezone=EXCLUDED.timezone,slot_increment_minutes=EXCLUDED.slot_increment_minutes,
       minimum_notice_minutes=EXCLUDED.minimum_notice_minutes,maximum_advance_days=EXCLUDED.maximum_advance_days,
       buffer_before_minutes=EXCLUDED.buffer_before_minutes,buffer_after_minutes=EXCLUDED.buffer_after_minutes,
       cancellation_notice_hours=EXCLUDED.cancellation_notice_hours,updated_at=NOW() RETURNING *`,
    [p.id,vals.timezone,vals.slot,vals.notice,vals.advance,vals.before,vals.after,vals.cancel]
  );res.json({settings:r.rows[0]});
}));
router.put('/availability',asyncRoute(async(req,res)=>{
  const p=await provider(req,res);if(!p)return; const windows=Array.isArray(req.body.windows)?req.body.windows:[];
  for(const w of windows){if(Number(w.dayOfWeek)<0||Number(w.dayOfWeek)>6||!/^\d{2}:\d{2}$/.test(w.startTime||'')||!/^\d{2}:\d{2}$/.test(w.endTime||'')||w.startTime>=w.endTime)return res.status(400).json({message:'Each availability window needs a valid day and start/end time.'});}
  const c=await pool.connect();try{await c.query('BEGIN');await c.query(`DELETE FROM provider_availability WHERE provider_id=$1`,[p.id]);
    for(const w of windows)await c.query(`INSERT INTO provider_availability(provider_id,day_of_week,start_time,end_time,is_active) VALUES($1,$2,$3,$4,TRUE)`,[p.id,Number(w.dayOfWeek),w.startTime,w.endTime]);
    await c.query('COMMIT');res.json({message:'Weekly availability saved.'});}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}));
router.post('/blocks',asyncRoute(async(req,res)=>{
  const p=await provider(req,res);if(!p)return;const s=new Date(req.body.startsAt),e=new Date(req.body.endsAt);
  if(Number.isNaN(s.getTime())||Number.isNaN(e.getTime())||s>=e)return res.status(400).json({message:'Valid block start and end dates are required.'});
  const r=await pool.query(`INSERT INTO provider_calendar_blocks(provider_id,starts_at,ends_at,reason) VALUES($1,$2,$3,$4) RETURNING *`,[p.id,s,e,req.body.reason||null]);res.status(201).json({block:r.rows[0]});
}));
router.delete('/blocks/:id',asyncRoute(async(req,res)=>{
  const p=await provider(req,res);if(!p)return;const r=await pool.query(`DELETE FROM provider_calendar_blocks WHERE id=$1 AND provider_id=$2 RETURNING id`,[req.params.id,p.id]);if(!r.rowCount)return res.status(404).json({message:'Calendar block not found.'});res.json({message:'Block removed.'});
}));
router.get('/external-connections',asyncRoute(async(req,res)=>{const p=await provider(req,res);if(!p)return;const r=await pool.query(`SELECT id,provider_name,external_account,sync_status,last_synced_at,created_at FROM external_calendar_connections WHERE provider_id=$1 ORDER BY provider_name`,[p.id]);res.json({connections:r.rows});}));
router.post('/external-connections/demo',asyncRoute(async(req,res)=>{const p=await provider(req,res);if(!p)return;const name=String(req.body.providerName||'').toUpperCase();if(!['GOOGLE','OUTLOOK'].includes(name))return res.status(400).json({message:'providerName must be GOOGLE or OUTLOOK.'});const r=(await pool.query(`INSERT INTO external_calendar_connections(provider_id,provider_name,external_account,token_reference,sync_status,last_synced_at) VALUES($1,$2,$3,'DEMO_ONLY','CONNECTED',NOW()) ON CONFLICT DO NOTHING RETURNING id,provider_name,external_account,sync_status,last_synced_at`,[p.id,name,req.body.externalAccount||`${name.toLowerCase()}@demo.local`])).rows[0];res.status(201).json({connection:r||null,message:'Demo calendar connection recorded. No external OAuth or calendar events are synchronized in this MVP.'});}));

module.exports=router;
