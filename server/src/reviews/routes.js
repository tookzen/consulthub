const express=require('express');
const pool=require('../db');
const {authenticate,authorize}=require('../auth');
const {notify}=require('../services/notifications');
const router=express.Router();
const asyncRoute=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);

router.post('/',authenticate,authorize('CLIENT'),asyncRoute(async(req,res)=>{
  const {appointmentId,rating,reviewText}=req.body;
  const numericRating=Number(rating);
  const comment=String(reviewText||'').trim();
  if(!appointmentId)return res.status(400).json({message:'appointmentId is required.'});
  if(!Number.isInteger(numericRating)||numericRating<1||numericRating>5)return res.status(400).json({message:'Rating must be a whole number between 1 and 5.'});
  if(comment.length>2000)return res.status(400).json({message:'Comment must be 2,000 characters or fewer.'});

  const a=await pool.query(`SELECT a.*,p.id provider_id,p.user_id provider_user_id,s.name service_name
    FROM appointments a
    JOIN provider_profiles p ON p.id=a.provider_id
    JOIN provider_services s ON s.id=a.service_id
    WHERE a.id=$1 AND a.client_user_id=$2 AND a.status='COMPLETED'`,[appointmentId,req.user.sub]);
  if(!a.rowCount)return res.status(409).json({message:'Only completed appointments belonging to you can be reviewed.'});

  const r=await pool.query(`INSERT INTO reviews(appointment_id,client_user_id,provider_id,rating,review_text,updated_at)
    VALUES($1,$2,$3,$4,$5,NOW())
    ON CONFLICT(appointment_id) DO UPDATE SET rating=EXCLUDED.rating,review_text=EXCLUDED.review_text,moderation_status='PENDING',updated_at=NOW()
    RETURNING *`,[appointmentId,req.user.sub,a.rows[0].provider_id,numericRating,comment||null]);

  await notify({
    userId:a.rows[0].provider_user_id,
    type:'REVIEW_SUBMITTED',
    title:'New client rating received',
    message:`A client submitted a ${numericRating}-star rating for ${a.rows[0].service_name}. It is awaiting moderation.`,
    relatedType:'REVIEW',
    relatedId:r.rows[0].id
  });

  res.status(201).json({review:r.rows[0],message:'Thanks. Your rating and comment were submitted for moderation.'});
}));

router.get('/mine/:appointmentId',authenticate,authorize('CLIENT'),asyncRoute(async(req,res)=>{
  const r=await pool.query(`SELECT * FROM reviews WHERE appointment_id=$1 AND client_user_id=$2`,[req.params.appointmentId,req.user.sub]);
  res.json({review:r.rows[0]||null});
}));

router.get('/provider/:providerId',asyncRoute(async(req,res)=>{
  const r=await pool.query(`SELECT r.id,r.rating,r.review_text,r.professional_response,r.professional_responded_at,r.created_at,u.first_name client_first_name
    FROM reviews r JOIN users u ON u.id=r.client_user_id
    WHERE r.provider_id=$1 AND r.moderation_status='APPROVED'
    ORDER BY r.created_at DESC LIMIT 100`,[req.params.providerId]);
  const stats=await pool.query(`SELECT COUNT(*)::int count,COALESCE(AVG(rating),0)::float average
    FROM reviews WHERE provider_id=$1 AND moderation_status='APPROVED'`,[req.params.providerId]);
  res.json({reviews:r.rows,stats:stats.rows[0]});
}));

router.post('/:id/respond',authenticate,authorize('PROVIDER'),asyncRoute(async(req,res)=>{
  const response=String(req.body.response||'').trim();
  if(response.length>2000)return res.status(400).json({message:'Response must be 2,000 characters or fewer.'});
  const r=await pool.query(`UPDATE reviews SET professional_response=$3,professional_responded_at=NOW(),updated_at=NOW()
    WHERE id=$1 AND provider_id=(SELECT id FROM provider_profiles WHERE user_id=$2) RETURNING *`,[req.params.id,req.user.sub,response||null]);
  if(!r.rowCount)return res.status(404).json({message:'Review not found.'});
  res.json({review:r.rows[0]});
}));

module.exports=router;
