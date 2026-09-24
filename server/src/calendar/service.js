const pool = require('../db');

async function expireHolds(client = pool) {
  const expired = await client.query(
    `UPDATE appointments
        SET status='EXPIRED', updated_at=NOW()
      WHERE status='PENDING' AND payment_status IN ('UNPAID','PENDING','FAILED')
        AND hold_expires_at IS NOT NULL AND hold_expires_at <= NOW()
      RETURNING id`
  );
  return expired.rows.map(r => r.id);
}

async function getSettings(providerId, client = pool) {
  await client.query(`INSERT INTO provider_calendar_settings(provider_id) VALUES ($1) ON CONFLICT(provider_id) DO NOTHING`, [providerId]);
  const r = await client.query(`SELECT * FROM provider_calendar_settings WHERE provider_id=$1`, [providerId]);
  return r.rows[0];
}

function zonedParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23' });
  return Object.fromEntries(fmt.formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
}

function zonedLocalToUtc(dateText, timeText, timeZone) {
  const [y,m,d] = dateText.split('-').map(Number);
  const [hh,mm,ss=0] = timeText.split(':').map(Number);
  const naive = Date.UTC(y,m-1,d,hh,mm,ss);
  let guess = naive;
  for (let i=0;i<2;i++) {
    const p=zonedParts(new Date(guess),timeZone);
    const represented=Date.UTC(Number(p.year),Number(p.month)-1,Number(p.day),Number(p.hour),Number(p.minute),Number(p.second));
    guess += naive-represented;
  }
  return new Date(guess);
}

function addDays(dateText, days) {
  const d=new Date(`${dateText}T00:00:00Z`);d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);
}

async function getSlots({ providerId, date, serviceId }) {
  await expireHolds();
  const provider = await pool.query(`SELECT verification_status FROM provider_profiles WHERE id=$1`, [providerId]);
  if (!provider.rowCount) return { notFound: true };
  if (provider.rows[0].verification_status !== 'VERIFIED') return { date, slots: [], unavailableReason: 'Provider verification is not approved.' };
  const service = await pool.query(`SELECT duration_minutes FROM provider_services WHERE id=$1 AND provider_id=$2 AND is_active=TRUE`, [serviceId, providerId]);
  if (!service.rowCount) return { invalidService: true };

  const settings = await getSettings(providerId);
  const timeZone = settings.timezone || 'Africa/Johannesburg';
  const duration = Number(service.rows[0].duration_minutes);
  const increment = Number(settings.slot_increment_minutes);
  const dayOfWeek = new Date(`${date}T00:00:00Z`).getUTCDay();
  const dayStart = zonedLocalToUtc(date,'00:00:00',timeZone);
  const dayEnd = zonedLocalToUtc(addDays(date,1),'00:00:00',timeZone);
  const availability = await pool.query(
    `SELECT start_time::text,end_time::text FROM provider_availability
      WHERE provider_id=$1 AND day_of_week=$2 AND is_active=TRUE ORDER BY start_time`, [providerId,dayOfWeek]
  );
  const busy = await pool.query(
    `SELECT starts_at - ($4::int * INTERVAL '1 minute') AS starts_at,
            ends_at + ($5::int * INTERVAL '1 minute') AS ends_at
       FROM appointments
      WHERE provider_id=$1 AND starts_at<$3 AND ends_at>$2
        AND (status='CONFIRMED' OR (status='PENDING' AND hold_expires_at>NOW()))
      UNION ALL
     SELECT starts_at,ends_at FROM provider_calendar_blocks
      WHERE provider_id=$1 AND starts_at<$3 AND ends_at>$2`,
    [providerId,dayStart,dayEnd,settings.buffer_before_minutes,settings.buffer_after_minutes]
  );
  const now=Date.now();
  const minStart=now+Number(settings.minimum_notice_minutes)*60000;
  const maxStart=now+Number(settings.maximum_advance_days)*86400000;
  const occupied=busy.rows.map(x=>({start:new Date(x.starts_at).getTime(),end:new Date(x.ends_at).getTime()}));
  const slots=[];
  for(const w of availability.rows){
    const windowStart=zonedLocalToUtc(date,w.start_time.slice(0,8),timeZone).getTime();
    const windowEnd=zonedLocalToUtc(date,w.end_time.slice(0,8),timeZone).getTime();
    for(let start=windowStart;start+duration*60000<=windowEnd;start+=increment*60000){
      const end=start+duration*60000;
      if(start<minStart||start>maxStart)continue;
      if(!occupied.some(b=>start<b.end&&end>b.start))slots.push(new Date(start).toISOString());
    }
  }
  return {date,slots,slotMinutes:duration,incrementMinutes:increment,timeZone,settings};
}

module.exports={expireHolds,getSettings,getSlots,zonedLocalToUtc};
