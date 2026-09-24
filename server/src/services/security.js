const pool = require('../db');

const buckets = new Map();
function rateLimit({ windowMs = 60_000, max = 60, key = req => req.ip || 'unknown' } = {}) {
  return (req, res, next) => {
    const now = Date.now();
    const k = key(req);
    const bucket = buckets.get(k);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(k, { count: 1, resetAt: now + windowMs });
      return next();
    }
    bucket.count += 1;
    if (bucket.count > max) {
      res.setHeader('Retry-After', Math.ceil((bucket.resetAt - now) / 1000));
      return res.status(429).json({ message: 'Too many requests. Please try again shortly.' });
    }
    return next();
  };
}

function passwordIssues(password) {
  const value = String(password || '');
  const issues = [];
  if (value.length < 12) issues.push('at least 12 characters');
  if (!/[A-Z]/.test(value)) issues.push('an uppercase letter');
  if (!/[a-z]/.test(value)) issues.push('a lowercase letter');
  if (!/\d/.test(value)) issues.push('a number');
  if (!/[^A-Za-z0-9]/.test(value)) issues.push('a symbol');
  return issues;
}

async function securityEvent({ userId = null, type, severity = 'INFO', req, details = {}, client = pool }) {
  await client.query(
    `INSERT INTO security_events(user_id,event_type,severity,ip_address,user_agent,details)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [userId, type, severity, req?.ip || null, req?.headers?.['user-agent'] || null, JSON.stringify(details)]
  );
}

module.exports = { rateLimit, passwordIssues, securityEvent };
