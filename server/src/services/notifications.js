const pool = require('../db');

async function notify({ userId, type, title, message, relatedType = null, relatedId = null, channel = 'IN_APP', client = pool }) {
  const queued = channel !== 'IN_APP';
  const result = await client.query(
    `INSERT INTO notifications(user_id, notification_type, title, message, channel, status, related_type, related_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [userId, type, title, message, channel, queued ? 'QUEUED' : 'DELIVERED', relatedType, relatedId]
  );
  const notification = result.rows[0];
  if (queued) {
    await client.query(
      `INSERT INTO notification_jobs(notification_id,channel,payload)
       VALUES($1,$2,$3::jsonb)`,
      [notification.id, channel, JSON.stringify({userId,type,title,message,relatedType,relatedId})]
    );
  }
  return notification;
}

async function notifyBoth({userId,type,title,message,relatedType=null,relatedId=null,externalChannel='EMAIL_DEMO',client=pool}){
  await notify({userId,type,title,message,relatedType,relatedId,channel:'IN_APP',client});
  return notify({userId,type,title,message,relatedType,relatedId,channel:externalChannel,client});
}

module.exports = { notify, notifyBoth };
