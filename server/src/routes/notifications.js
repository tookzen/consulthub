const express=require('express');
const pool=require('../db');
const {authenticate}=require('../auth');
const router=express.Router();
const asyncRoute=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);

router.get('/unread-count',authenticate,asyncRoute(async(req,res)=>{
  const r=await pool.query(`SELECT COUNT(*)::int unread FROM notifications WHERE user_id=$1 AND read_at IS NULL`,[req.user.sub]);
  res.json({unread:r.rows[0].unread});
}));

router.get('/',authenticate,asyncRoute(async(req,res)=>{
  const [items,count]=await Promise.all([
    pool.query(`SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`,[req.user.sub]),
    pool.query(`SELECT COUNT(*)::int unread FROM notifications WHERE user_id=$1 AND read_at IS NULL`,[req.user.sub])
  ]);
  res.json({notifications:items.rows,unread:count.rows[0].unread});
}));

router.patch('/:id/read',authenticate,asyncRoute(async(req,res)=>{
  const r=await pool.query(`UPDATE notifications SET read_at=COALESCE(read_at,NOW()) WHERE id=$1 AND user_id=$2 RETURNING *`,[req.params.id,req.user.sub]);
  if(!r.rowCount)return res.status(404).json({message:'Notification not found.'});
  const count=await pool.query(`SELECT COUNT(*)::int unread FROM notifications WHERE user_id=$1 AND read_at IS NULL`,[req.user.sub]);
  res.json({notification:r.rows[0],unread:count.rows[0].unread});
}));

router.post('/read-all',authenticate,asyncRoute(async(req,res)=>{
  await pool.query(`UPDATE notifications SET read_at=COALESCE(read_at,NOW()) WHERE user_id=$1`,[req.user.sub]);
  res.json({message:'Notifications marked as read.',unread:0});
}));

module.exports=router;
