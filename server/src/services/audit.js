const pool = require('../db');

async function audit({actorUserId=null,eventType,entityType,entityId=null,action,beforeState=null,afterState=null,req=null,correlationId=null,client=pool}){
  await client.query(
    `INSERT INTO audit_events(actor_user_id,event_type,entity_type,entity_id,action,before_state,after_state,ip_address,user_agent,correlation_id)
     VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10)`,
    [actorUserId,eventType,entityType,entityId,action,beforeState?JSON.stringify(beforeState):null,afterState?JSON.stringify(afterState):null,req?.ip||null,req?.headers?.['user-agent']||null,correlationId||req?.headers?.['x-correlation-id']||null]
  );
}
module.exports={audit};
