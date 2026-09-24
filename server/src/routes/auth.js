const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const {
  signToken, authenticate, randomToken, hashToken, readCookie,
  clearRefreshCookie, createRefreshSession
} = require('../auth');
const { passwordIssues, securityEvent, rateLimit } = require('../services/security');
const { notify } = require('../services/notifications');

const router = express.Router();
const asyncRoute = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);
const DEV_EXPOSE_CODES = String(process.env.DEV_EXPOSE_AUTH_CODES || 'true').toLowerCase() === 'true';

function publicUser(row) {
  return {
    id: row.id, firstName: row.first_name, lastName: row.last_name, email: row.email,
    phone: row.phone, role: row.role, emailVerified: row.email_verified, phoneVerified: row.phone_verified,
    mfaEnabled: row.mfa_enabled, mfaMethod: row.mfa_method, lastLoginAt: row.last_login_at
  };
}
const isEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v || '');
const makeCode = () => String(Math.floor(100000 + Math.random() * 900000));

async function createChallenge(client, userId, type, minutes = 10) {
  await client.query(`UPDATE auth_challenges SET consumed_at=NOW() WHERE user_id=$1 AND challenge_type=$2 AND consumed_at IS NULL`, [userId, type]);
  const code = makeCode();
  await client.query(
    `INSERT INTO auth_challenges(user_id,challenge_type,code_hash,expires_at)
     VALUES ($1,$2,$3,NOW()+($4::text || ' minutes')::interval)`,
    [userId, type, await bcrypt.hash(code, 10), minutes]
  );
  return code;
}

async function consumeChallenge(client, userId, type, code) {
  const r = await client.query(
    `SELECT * FROM auth_challenges WHERE user_id=$1 AND challenge_type=$2 AND consumed_at IS NULL AND expires_at>NOW()
     ORDER BY created_at DESC LIMIT 1`, [userId, type]
  );
  if (!r.rowCount || !(await bcrypt.compare(String(code || ''), r.rows[0].code_hash))) return false;
  await client.query(`UPDATE auth_challenges SET consumed_at=NOW() WHERE id=$1`, [r.rows[0].id]);
  return true;
}

async function completeLogin(user, req, res) {
  await pool.query(`UPDATE users SET failed_login_attempts=0,locked_until=NULL,last_login_at=NOW(),updated_at=NOW() WHERE id=$1`, [user.id]);
  await createRefreshSession(user, req, res);
  await securityEvent({ userId:user.id, type:'LOGIN_SUCCESS', severity:'INFO', req });
  return res.json({ token: signToken(user), user: publicUser({ ...user, last_login_at: new Date() }) });
}

router.post('/register', rateLimit({windowMs:60_000,max:8}), asyncRoute(async (req,res) => {
  const { firstName,lastName,email,phone,password,role='CLIENT',profession,categoryId,city,biography,yearsExperience=0 } = req.body;
  const normalizedRole = String(role).toUpperCase();
  const issues = passwordIssues(password);
  if (!firstName || !lastName || !isEmail(email) || issues.length) {
    return res.status(400).json({ message:`First name, last name, valid email and a password containing ${issues.join(', ') || 'the required fields'} are required.` });
  }
  if (!['CLIENT','PROVIDER'].includes(normalizedRole)) return res.status(400).json({message:'Role must be CLIENT or PROVIDER.'});
  if (normalizedRole==='PROVIDER' && !profession) return res.status(400).json({message:'Profession is required for providers.'});

  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    if ((await client.query(`SELECT 1 FROM users WHERE LOWER(email)=LOWER($1)`,[email])).rowCount) {
      await client.query('ROLLBACK'); return res.status(409).json({message:'An account with this email already exists.'});
    }
    const passwordHash=await bcrypt.hash(password,12);
    const ur=await client.query(
      `INSERT INTO users(first_name,last_name,email,phone,password_hash,role,email_verified)
       VALUES($1,$2,LOWER($3),$4,$5,$6,FALSE) RETURNING *`,
      [firstName.trim(),lastName.trim(),email.trim(),phone||null,passwordHash,normalizedRole]
    );
    const user=ur.rows[0];
    if(normalizedRole==='PROVIDER') {
      await client.query(
        `INSERT INTO provider_profiles(user_id,category_id,profession,biography,years_experience,city)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [user.id,categoryId||null,profession.trim(),biography||null,Number(yearsExperience)||0,city||null]
      );
    }
    const code=await createChallenge(client,user.id,'EMAIL_VERIFY',20);
    await notify({userId:user.id,type:'EMAIL_VERIFICATION',title:'Verify your ConsultHub email',message:`Your verification code is ${code}. This is a development notification.`,channel:'EMAIL_DEMO',client});
    await client.query('COMMIT');
    await securityEvent({userId:user.id,type:'ACCOUNT_REGISTERED',req});
    res.status(201).json({ requiresEmailVerification:true, email:user.email, ...(DEV_EXPOSE_CODES?{devVerificationCode:code}:{}) });
  } catch(e){await client.query('ROLLBACK');throw e;} finally{client.release();}
}));

router.post('/verify-email', rateLimit({windowMs:60_000,max:10}), asyncRoute(async(req,res)=>{
  const {email,code}=req.body;
  const ur=await pool.query(`SELECT * FROM users WHERE LOWER(email)=LOWER($1)`,[email]);
  if(!ur.rowCount) return res.status(400).json({message:'Invalid verification request.'});
  const user=ur.rows[0]; const client=await pool.connect();
  try{
    await client.query('BEGIN');
    if(!(await consumeChallenge(client,user.id,'EMAIL_VERIFY',code))){await client.query('ROLLBACK');return res.status(400).json({message:'Invalid or expired verification code.'});}
    const updated=(await client.query(`UPDATE users SET email_verified=TRUE,email_verified_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *`,[user.id])).rows[0];
    await client.query('COMMIT');
    await createRefreshSession(updated,req,res); await securityEvent({userId:user.id,type:'EMAIL_VERIFIED',req});
    res.json({token:signToken(updated),user:publicUser(updated)});
  } catch(e){await client.query('ROLLBACK');throw e;} finally{client.release();}
}));

router.post('/resend-verification', rateLimit({windowMs:60_000,max:3}), asyncRoute(async(req,res)=>{
  const ur=await pool.query(`SELECT * FROM users WHERE LOWER(email)=LOWER($1)`,[req.body.email]);
  if(!ur.rowCount || ur.rows[0].email_verified) return res.json({message:'If verification is required, a new code has been issued.'});
  const code=await createChallenge(pool,ur.rows[0].id,'EMAIL_VERIFY',20);
  await notify({userId:ur.rows[0].id,type:'EMAIL_VERIFICATION',title:'New email verification code',message:`Your new verification code is ${code}.`,channel:'EMAIL_DEMO'});
  res.json({message:'Verification code issued.',...(DEV_EXPOSE_CODES?{devVerificationCode:code}:{})});
}));

router.post('/login', rateLimit({windowMs:60_000,max:12,key:req=>`${req.ip}:${String(req.body.email||'').toLowerCase()}`}), asyncRoute(async(req,res)=>{
  const {email,password}=req.body;
  if(!email||!password) return res.status(400).json({message:'Email and password are required.'});
  const ur=await pool.query(`SELECT * FROM users WHERE LOWER(email)=LOWER($1) AND is_active=TRUE`,[email]);
  if(!ur.rowCount) { await securityEvent({type:'LOGIN_UNKNOWN_ACCOUNT',severity:'LOW',req,details:{email}}); return res.status(401).json({message:'Invalid email or password.'}); }
  const user=ur.rows[0];
  if(user.locked_until && new Date(user.locked_until)>new Date()) return res.status(423).json({message:'Account temporarily locked after repeated failed logins.'});
  const valid=await bcrypt.compare(password,user.password_hash);
  if(!valid){
    const attempts=Number(user.failed_login_attempts||0)+1; const lock=attempts>=5;
    await pool.query(`UPDATE users SET failed_login_attempts=$2,locked_until=CASE WHEN $3 THEN NOW()+INTERVAL '15 minutes' ELSE NULL END WHERE id=$1`,[user.id,attempts,lock]);
    await securityEvent({userId:user.id,type:'LOGIN_FAILED',severity:lock?'HIGH':'LOW',req,details:{attempts,locked:lock}});
    return res.status(401).json({message:lock?'Account locked for 15 minutes after repeated failed attempts.':'Invalid email or password.'});
  }
  if(!user.email_verified) return res.status(403).json({message:'Verify your email before logging in.',code:'EMAIL_NOT_VERIFIED'});
  const roleRequiresMfa=['PROVIDER','ADMIN'].includes(user.role);
  if(user.mfa_enabled||roleRequiresMfa){
    const useSms=user.mfa_method==='SMS_DEMO'&&user.phone_verified;
    const challengeType=useSms?'MFA_SMS':'MFA_LOGIN';
    const code=await createChallenge(pool,user.id,challengeType,10);
    await notify({userId:user.id,type:'MFA_LOGIN',title:'ConsultHub sign-in code',message:`Your sign-in code is ${code}.`,channel:useSms?'SMS_DEMO':'EMAIL_DEMO'});
    return res.json({mfaRequired:true,mfaMethod:useSms?'SMS_DEMO':'EMAIL_DEMO',mfaTicket:signToken(user,{purpose:'mfa-ticket',expiresIn:'10m'}),...(DEV_EXPOSE_CODES?{devMfaCode:code}:{})});
  }
  return completeLogin(user,req,res);
}));

router.post('/mfa/verify-login', rateLimit({windowMs:60_000,max:10}), asyncRoute(async(req,res)=>{
  const {mfaTicket,code}=req.body;
  let payload;
  try { payload=require('jsonwebtoken').verify(mfaTicket,process.env.JWT_SECRET); } catch { return res.status(401).json({message:'Invalid MFA session.'}); }
  if(payload.purpose!=='mfa-ticket') return res.status(401).json({message:'Invalid MFA session.'});
  const ur=await pool.query(`SELECT * FROM users WHERE id=$1 AND is_active=TRUE`,[payload.sub]);
  if(!ur.rowCount) return res.status(401).json({message:'Invalid MFA session.'});
  const ok=(await consumeChallenge(pool,payload.sub,'MFA_LOGIN',code))||(await consumeChallenge(pool,payload.sub,'MFA_SMS',code));
  if(!ok) return res.status(401).json({message:'Invalid or expired MFA code.'});
  return completeLogin(ur.rows[0],req,res);
}));

router.post('/refresh', asyncRoute(async(req,res)=>{
  const raw=readCookie(req,'consulthub_refresh');
  if(!raw) return res.status(401).json({message:'Refresh session not found.'});
  const deviceId=String(req.headers['x-device-id']||'').slice(0,120)||null;
  const r=await pool.query(
    `SELECT s.*,u.* FROM refresh_sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>NOW() AND u.is_active=TRUE
        AND (s.device_id IS NULL OR s.device_id=$2)
        AND NOT EXISTS(SELECT 1 FROM user_devices d WHERE d.user_id=s.user_id AND d.device_id=s.device_id AND d.revoked_at IS NOT NULL)`,[hashToken(raw),deviceId]
  );
  if(!r.rowCount){clearRefreshCookie(res);return res.status(401).json({message:'Refresh session expired.'});}
  const row=r.rows[0];
  const rotated=await pool.query(`UPDATE refresh_sessions SET revoked_at=NOW(),last_used_at=NOW() WHERE token_hash=$1 AND revoked_at IS NULL RETURNING id`,[hashToken(raw)]);
  if(!rotated.rowCount){clearRefreshCookie(res);return res.status(401).json({message:'Refresh session has already been rotated.'});}
  await createRefreshSession({id:row.user_id||row.id,email:row.email,role:row.role},req,res);
  res.json({token:signToken({id:row.user_id||row.id,email:row.email,role:row.role}),user:publicUser(row)});
}));

router.post('/logout', asyncRoute(async(req,res)=>{
  const raw=readCookie(req,'consulthub_refresh');
  if(raw) await pool.query(`UPDATE refresh_sessions SET revoked_at=NOW() WHERE token_hash=$1`,[hashToken(raw)]);
  clearRefreshCookie(res); res.json({message:'Logged out.'});
}));

router.get('/me',authenticate,asyncRoute(async(req,res)=>{
  const r=await pool.query(`SELECT * FROM users WHERE id=$1`,[req.user.sub]);
  if(!r.rowCount) return res.status(404).json({message:'User not found.'});
  res.json({user:publicUser(r.rows[0])});
}));

router.post('/mfa/setup',authenticate,asyncRoute(async(req,res)=>{
  const code=await createChallenge(pool,req.user.sub,'MFA_LOGIN',15);
  await notify({userId:req.user.sub,type:'MFA_SETUP',title:'Confirm MFA setup',message:`Your MFA setup code is ${code}.`,channel:'EMAIL_DEMO'});
  res.json({message:'MFA setup challenge created.',...(DEV_EXPOSE_CODES?{devMfaCode:code}:{})});
}));
router.post('/mfa/confirm',authenticate,asyncRoute(async(req,res)=>{
  if(!(await consumeChallenge(pool,req.user.sub,'MFA_LOGIN',req.body.code))) return res.status(400).json({message:'Invalid or expired MFA code.'});
  await pool.query(`UPDATE users SET mfa_enabled=TRUE,mfa_method='EMAIL_DEMO',updated_at=NOW() WHERE id=$1`,[req.user.sub]);
  await securityEvent({userId:req.user.sub,type:'MFA_ENABLED',req}); res.json({message:'MFA enabled.'});
}));
router.post('/mfa/disable',authenticate,asyncRoute(async(req,res)=>{
  const r=await pool.query(`SELECT * FROM users WHERE id=$1`,[req.user.sub]);
  if(!r.rowCount || !(await bcrypt.compare(req.body.password||'',r.rows[0].password_hash))) return res.status(401).json({message:'Current password is required.'});
  await pool.query(`UPDATE users SET mfa_enabled=FALSE,mfa_method=NULL,updated_at=NOW() WHERE id=$1`,[req.user.sub]);
  await securityEvent({userId:req.user.sub,type:'MFA_DISABLED',severity:'MEDIUM',req}); res.json({message:'MFA disabled.'});
}));

router.post('/password-reset/request',rateLimit({windowMs:60_000,max:4}),asyncRoute(async(req,res)=>{
  const r=await pool.query(`SELECT * FROM users WHERE LOWER(email)=LOWER($1)`,[req.body.email]);
  if(!r.rowCount) return res.json({message:'If the account exists, a reset code has been issued.'});
  const code=await createChallenge(pool,r.rows[0].id,'PASSWORD_RESET',15);
  await notify({userId:r.rows[0].id,type:'PASSWORD_RESET',title:'Password reset code',message:`Your password reset code is ${code}.`,channel:'EMAIL_DEMO'});
  res.json({message:'Reset code issued.',...(DEV_EXPOSE_CODES?{devResetCode:code}:{})});
}));
router.post('/password-reset/confirm',rateLimit({windowMs:60_000,max:8}),asyncRoute(async(req,res)=>{
  const {email,code,newPassword}=req.body; const issues=passwordIssues(newPassword);
  if(issues.length) return res.status(400).json({message:`Password must contain ${issues.join(', ')}.`});
  const r=await pool.query(`SELECT * FROM users WHERE LOWER(email)=LOWER($1)`,[email]);
  if(!r.rowCount || !(await consumeChallenge(pool,r.rows[0].id,'PASSWORD_RESET',code))) return res.status(400).json({message:'Invalid or expired reset code.'});
  await pool.query(`UPDATE users SET password_hash=$2,failed_login_attempts=0,locked_until=NULL,updated_at=NOW() WHERE id=$1`,[r.rows[0].id,await bcrypt.hash(newPassword,12)]);
  await pool.query(`UPDATE refresh_sessions SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL`,[r.rows[0].id]);
  await securityEvent({userId:r.rows[0].id,type:'PASSWORD_RESET_COMPLETED',severity:'MEDIUM',req}); res.json({message:'Password reset completed.'});
}));


router.post('/phone/request',authenticate,rateLimit({windowMs:60_000,max:4}),asyncRoute(async(req,res)=>{
  const r=await pool.query(`SELECT * FROM users WHERE id=$1`,[req.user.sub]);
  if(!r.rowCount||!r.rows[0].phone)return res.status(400).json({message:'Add a mobile number to your account before requesting verification.'});
  const code=await createChallenge(pool,req.user.sub,'PHONE_VERIFY',10);
  await notify({userId:req.user.sub,type:'PHONE_VERIFICATION',title:'Verify your mobile number',message:`Your ConsultHub mobile verification code is ${code}.`,channel:'SMS_DEMO'});
  res.json({message:'Mobile verification code issued.',...(DEV_EXPOSE_CODES?{devPhoneCode:code}:{})});
}));

router.post('/phone/verify',authenticate,rateLimit({windowMs:60_000,max:8}),asyncRoute(async(req,res)=>{
  if(!(await consumeChallenge(pool,req.user.sub,'PHONE_VERIFY',req.body.code)))return res.status(400).json({message:'Invalid or expired mobile verification code.'});
  const r=(await pool.query(`UPDATE users SET phone_verified=TRUE,phone_verified_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *`,[req.user.sub])).rows[0];
  await securityEvent({userId:req.user.sub,type:'PHONE_VERIFIED',req});
  res.json({message:'Mobile number verified.',user:publicUser(r)});
}));

router.get('/sessions',authenticate,asyncRoute(async(req,res)=>{
  const r=await pool.query(`SELECT s.id,s.device_id,s.user_agent,s.ip_address,s.created_at,s.last_used_at,s.expires_at,s.revoked_at,d.device_name,d.trusted,d.last_seen_at
    FROM refresh_sessions s LEFT JOIN user_devices d ON d.user_id=s.user_id AND d.device_id=s.device_id
    WHERE s.user_id=$1 ORDER BY s.last_used_at DESC`,[req.user.sub]);
  res.json({sessions:r.rows});
}));

router.delete('/sessions/:id',authenticate,asyncRoute(async(req,res)=>{
  const r=await pool.query(`UPDATE refresh_sessions SET revoked_at=NOW() WHERE id=$1 AND user_id=$2 RETURNING id,device_id`,[req.params.id,req.user.sub]);
  if(!r.rowCount)return res.status(404).json({message:'Session not found.'});
  await securityEvent({userId:req.user.sub,type:'SESSION_REVOKED',severity:'MEDIUM',req,details:{sessionId:req.params.id}});
  res.json({message:'Session revoked.'});
}));

router.get('/devices',authenticate,asyncRoute(async(req,res)=>{
  const r=await pool.query(`SELECT * FROM user_devices WHERE user_id=$1 ORDER BY last_seen_at DESC`,[req.user.sub]);res.json({devices:r.rows});
}));

router.patch('/devices/:id',authenticate,asyncRoute(async(req,res)=>{
  const r=await pool.query(`UPDATE user_devices SET trusted=COALESCE($3,trusted),device_name=COALESCE($4,device_name) WHERE id=$1 AND user_id=$2 RETURNING *`,[req.params.id,req.user.sub,typeof req.body.trusted==='boolean'?req.body.trusted:null,req.body.deviceName||null]);
  if(!r.rowCount)return res.status(404).json({message:'Device not found.'});res.json({device:r.rows[0]});
}));

router.delete('/devices/:id',authenticate,asyncRoute(async(req,res)=>{
  const d=await pool.query(`UPDATE user_devices SET revoked_at=NOW(),trusted=FALSE WHERE id=$1 AND user_id=$2 RETURNING device_id`,[req.params.id,req.user.sub]);
  if(!d.rowCount)return res.status(404).json({message:'Device not found.'});
  await pool.query(`UPDATE refresh_sessions SET revoked_at=NOW() WHERE user_id=$1 AND device_id=$2 AND revoked_at IS NULL`,[req.user.sub,d.rows[0].device_id]);
  await securityEvent({userId:req.user.sub,type:'DEVICE_REVOKED',severity:'MEDIUM',req,details:{deviceId:d.rows[0].device_id}});res.json({message:'Device and its refresh sessions revoked.'});
}));

module.exports=router;
