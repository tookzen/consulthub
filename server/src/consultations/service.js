const pool = require('../db');
const { reference } = require('../services/helpers');

async function ensureConsultationRoom({ appointmentId, startsAt, endsAt, client = pool }) {
  const result = await client.query(
    `INSERT INTO consultation_rooms(appointment_id, room_code, status, opens_at, closes_at)
     VALUES($1, $2, 'READY', $3::timestamptz - INTERVAL '15 minutes', $4::timestamptz + INTERVAL '30 minutes')
     ON CONFLICT(appointment_id) DO UPDATE
       SET opens_at = EXCLUDED.opens_at,
           closes_at = EXCLUDED.closes_at
     RETURNING *`,
    [appointmentId, reference('ROOM'), startsAt, endsAt]
  );

  return result.rows[0];
}

module.exports = { ensureConsultationRoom };
