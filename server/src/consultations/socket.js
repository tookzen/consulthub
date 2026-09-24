const {WebSocketServer}=require('ws');const {verifyRoomToken}=require('../auth');const pool=require('../db');
function attachConsultationSockets(server){
  const wss=new WebSocketServer({server,path:'/ws/consultations'});const rooms=new Map();
  wss.on('connection',async(ws,req)=>{
    try{
      const url=new URL(req.url,'http://localhost');const token=url.searchParams.get('token');const auth=verifyRoomToken(token);ws.auth=auth;
      const db=await pool.query(`SELECT * FROM consultation_rooms WHERE id=$1 AND appointment_id=$2 AND closes_at>NOW()`,[auth.roomId,auth.appointmentId]);if(!db.rowCount){ws.close(4003,'Room unavailable');return;}
      if(!rooms.has(auth.roomId))rooms.set(auth.roomId,new Set());const peers=rooms.get(auth.roomId);if(peers.size>=2&&auth.role!=='ADMIN'){ws.close(4004,'Room full');return;}
      peers.add(ws);await pool.query(`INSERT INTO consultation_room_events(room_id,user_id,event_type) VALUES($1,$2,'SOCKET_JOIN')`,[auth.roomId,auth.sub]);
      if(peers.size>1)for(const peer of peers)if(peer.readyState===1)peer.send(JSON.stringify({type:'peer-ready'}));
      ws.on('message',raw=>{let msg;try{msg=JSON.parse(raw.toString());}catch{return;}if(!['offer','answer','ice','chat','leave','transcript','recording-state'].includes(msg.type))return;for(const peer of peers)if(peer!==ws&&peer.readyState===1)peer.send(JSON.stringify({...msg,from:auth.sub}));});
      ws.on('close',async()=>{peers.delete(ws);if(!peers.size)rooms.delete(auth.roomId);try{await pool.query(`INSERT INTO consultation_room_events(room_id,user_id,event_type) VALUES($1,$2,'SOCKET_LEAVE')`,[auth.roomId,auth.sub]);}catch{}for(const peer of peers)if(peer.readyState===1)peer.send(JSON.stringify({type:'peer-left'}));});
    }catch{ws.close(4001,'Invalid room token');}
  });
  return wss;
}
module.exports={attachConsultationSockets};
