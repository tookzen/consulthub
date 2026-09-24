const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pool = require('./db');

const ADMIN_ROLE_PERMISSIONS={
  SUPER_ADMIN:['*'],
  VERIFICATION_ADMIN:['verification:read','verification:write','providers:read'],
  SUPPORT_AGENT:['users:read','users:support','appointments:read','requests:read','cases:read'],
  FINANCE_ADMIN:['payments:read','payments:write','refunds:write','payouts:write','invoices:read'],
  COMPLIANCE_ADMIN:['cases:read','cases:write','security:read','privacy:read','privacy:write','documents:audit','audit:read']
};

function signToken(user, options = {}) {
  return jwt.sign(
    { sub: user.id, role: user.role, email: user.email, purpose: options.purpose || 'access' },
    process.env.JWT_SECRET,
    { expiresIn: options.expiresIn || process.env.JWT_EXPIRES_IN || '20m' }
  );
}
function signRoomToken({ userId, appointmentId, roomId, role }) {return jwt.sign({sub:userId,appointmentId,roomId,role,purpose:'consultation-room'},process.env.JWT_SECRET,{expiresIn:'2h'});}
function verifyRoomToken(token) {const p=jwt.verify(token,process.env.JWT_SECRET);if(p.purpose!=='consultation-room')throw new Error('Invalid room token.');return p;}
function signDocumentToken({userId,documentId}){return jwt.sign({sub:userId,documentId,purpose:'document-download'},process.env.JWT_SECRET,{expiresIn:'5m'});}
function verifyDocumentToken(token){const p=jwt.verify(token,process.env.JWT_SECRET);if(p.purpose!=='document-download')throw new Error('Invalid document token.');return p;}
function randomToken(bytes = 48) {return crypto.randomBytes(bytes).toString('hex');}
function hashToken(value) {return crypto.createHash('sha256').update(String(value)).digest('hex');}
function readCookie(req, name) {const header=req.headers.cookie||'';const found=header.split(';').map(x=>x.trim()).find(x=>x.startsWith(`${name}=`));return found?decodeURIComponent(found.slice(name.length+1)):null;}
function setRefreshCookie(res, token) {const secure=String(process.env.COOKIE_SECURE||'false').toLowerCase()==='true';const maxAge=7*24*60*60;const parts=[`consulthub_refresh=${encodeURIComponent(token)}`,'HttpOnly','Path=/api/auth','SameSite=Lax',`Max-Age=${maxAge}`];if(secure)parts.push('Secure');res.setHeader('Set-Cookie',parts.join('; '));}
function clearRefreshCookie(res) {res.setHeader('Set-Cookie','consulthub_refresh=; HttpOnly; Path=/api/auth; SameSite=Lax; Max-Age=0');}

async function recordDevice(userId,req,client=pool){
  const deviceId=String(req.headers['x-device-id']||'').slice(0,120)||null;if(!deviceId)return null;
  const name=String(req.headers['x-device-name']||'Browser').slice(0,180);
  const r=await client.query(`INSERT INTO user_devices(user_id,device_id,device_name,user_agent,first_ip,last_ip,last_seen_at)
    VALUES($1,$2,$3,$4,$5,$5,NOW()) ON CONFLICT(user_id,device_id) DO UPDATE SET device_name=EXCLUDED.device_name,user_agent=EXCLUDED.user_agent,last_ip=EXCLUDED.last_ip,last_seen_at=NOW(),revoked_at=NULL RETURNING *`,[userId,deviceId,name,req.headers['user-agent']||null,req.ip||null]);return r.rows[0];
}

async function createRefreshSession(user, req, res) {
  const raw=randomToken(48);const tokenHash=hashToken(raw);const deviceId=String(req.headers['x-device-id']||'').slice(0,120)||null;
  await pool.query(`INSERT INTO refresh_sessions(user_id,token_hash,user_agent,ip_address,device_id,expires_at) VALUES($1,$2,$3,$4,$5,NOW()+INTERVAL '7 days')`,[user.id,tokenHash,req.headers['user-agent']||null,req.ip||null,deviceId]);
  await recordDevice(user.id,req);setRefreshCookie(res,raw);
}

async function authenticate(req,res,next){const header=req.headers.authorization||'';const[scheme,token]=header.split(' ');if(scheme!=='Bearer'||!token)return res.status(401).json({message:'Authentication required.'});try{const payload=jwt.verify(token,process.env.JWT_SECRET);if(payload.purpose&&payload.purpose!=='access')throw new Error('Wrong token purpose');const result=await pool.query('SELECT id,role,email,is_active,locked_until FROM users WHERE id=$1',[payload.sub]);if(!result.rowCount||!result.rows[0].is_active)return res.status(401).json({message:'Account is not active.'});if(result.rows[0].locked_until&&new Date(result.rows[0].locked_until)>new Date())return res.status(423).json({message:'Account is temporarily locked.'});req.user={...payload,role:result.rows[0].role,email:result.rows[0].email};return next();}catch{return res.status(401).json({message:'Invalid or expired token.'});}}
function authorize(...roles){return(req,res,next)=>{if(!req.user||!roles.includes(req.user.role))return res.status(403).json({message:'You do not have permission for this action.'});return next();};}

async function adminRoles(userId,client=pool){const r=await client.query(`SELECT admin_role FROM admin_role_assignments WHERE user_id=$1`,[userId]);return r.rows.map(x=>x.admin_role);}
function authorizeAdmin(...permissions){return async(req,res,next)=>{if(!req.user||req.user.role!=='ADMIN')return res.status(403).json({message:'Administrator access required.'});const roles=await adminRoles(req.user.sub);if(roles.includes('SUPER_ADMIN')){req.adminRoles=roles;return next();}const allowed=new Set(roles.flatMap(r=>ADMIN_ROLE_PERMISSIONS[r]||[]));if(permissions.every(p=>allowed.has(p))){req.adminRoles=roles;return next();}return res.status(403).json({message:'Your administrator role does not permit this action.',requiredPermissions:permissions});};}

module.exports={signToken,signRoomToken,verifyRoomToken,signDocumentToken,verifyDocumentToken,authenticate,authorize,authorizeAdmin,adminRoles,randomToken,hashToken,readCookie,setRefreshCookie,clearRefreshCookie,createRefreshSession,recordDevice,ADMIN_ROLE_PERMISSIONS};
