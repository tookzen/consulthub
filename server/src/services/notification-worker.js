const pool=require('../db');
async function processNotificationJobs(limit=50){
  const c=await pool.connect();try{
    await c.query('BEGIN');
    const jobs=await c.query(`SELECT * FROM notification_jobs WHERE status='QUEUED' AND available_at<=NOW() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $1`,[limit]);
    for(const job of jobs.rows){
      try{
        await c.query(`UPDATE notification_jobs SET status='PROCESSING',attempts=attempts+1 WHERE id=$1`,[job.id]);
        // Development dispatcher only. Production adapters should send via SES/SMS/WhatsApp and store provider message IDs.
        console.log(`[notification:${job.channel}]`,job.payload?.title||'',job.payload?.userId||'');
        await c.query(`UPDATE notification_jobs SET status='DELIVERED',processed_at=NOW(),last_error=NULL WHERE id=$1`,[job.id]);
        if(job.notification_id)await c.query(`UPDATE notifications SET status='DELIVERED' WHERE id=$1`,[job.notification_id]);
      }catch(e){
        await c.query(`UPDATE notification_jobs SET status=CASE WHEN attempts>=4 THEN 'FAILED' ELSE 'QUEUED' END,available_at=NOW()+INTERVAL '2 minutes',last_error=$2 WHERE id=$1`,[job.id,String(e.message||e)]);
        if(job.notification_id)await c.query(`UPDATE notifications SET status='FAILED' WHERE id=$1 AND (SELECT attempts FROM notification_jobs WHERE id=$2)>=4`,[job.notification_id,job.id]);
      }
    }
    await c.query('COMMIT');return jobs.rowCount;
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
module.exports={processNotificationJobs};
