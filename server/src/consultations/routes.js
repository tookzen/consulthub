const express = require('express');
const pool = require('../db');
const { authenticate, signRoomToken } = require('../auth');
const { ensureConsultationRoom } = require('./service');

const router = express.Router();
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function loadAppointment(appointmentId) {
  const result = await pool.query(
    `SELECT
       a.id appointment_id,
       a.client_user_id,
       a.provider_id,
       a.starts_at,
       a.ends_at,
       a.status appointment_status,
       a.payment_status,
       p.user_id provider_user_id,
       s.name service_name,
       cu.first_name client_first_name,
       cu.last_name client_last_name,
       pu.first_name provider_first_name,
       pu.last_name provider_last_name,
       cr.id room_id,
       cr.room_code,
       cr.status room_status,
       cr.opens_at,
       cr.closes_at,
       COALESCE(aw.workflow_key, 'GENERAL') workflow_key,
       COALESCE(aw.room_access_status, 'ALLOWED') room_access_status,
       aw.intake_status,
       aw.provider_clearance_status,
       NOW() database_now
     FROM appointments a
     JOIN provider_profiles p ON p.id = a.provider_id
     JOIN users cu ON cu.id = a.client_user_id
     JOIN users pu ON pu.id = p.user_id
     JOIN provider_services s ON s.id = a.service_id
     LEFT JOIN consultation_rooms cr ON cr.appointment_id = a.id
     LEFT JOIN appointment_workflows aw ON aw.appointment_id = a.id
     WHERE a.id = $1`,
    [appointmentId]
  );
  return result.rows[0] || null;
}

router.get('/:appointmentId/join', authenticate, asyncRoute(async (req, res) => {
  let appointment = await loadAppointment(req.params.appointmentId);
  if (!appointment) {
    return res.status(404).json({ message: 'Appointment not found.' });
  }

  const isParticipant = [appointment.client_user_id, appointment.provider_user_id].includes(req.user.sub);
  if (!isParticipant && req.user.role !== 'ADMIN') {
    return res.status(403).json({ message: 'You are not a participant in this consultation.' });
  }

  if (appointment.appointment_status !== 'CONFIRMED' || appointment.payment_status !== 'PAID') {
    return res.status(409).json({
      message: 'The consultation room becomes available after the appointment is confirmed and payment is completed.',
      appointmentStatus: appointment.appointment_status,
      paymentStatus: appointment.payment_status,
      code: 'ROOM_NOT_READY'
    });
  }

  // Self-heal older/partially migrated paid appointments that do not yet have a room row.
  if (!appointment.room_id) {
    await ensureConsultationRoom({
      appointmentId: appointment.appointment_id,
      startsAt: appointment.starts_at,
      endsAt: appointment.ends_at
    });
    appointment = await loadAppointment(req.params.appointmentId);
  }

  if (appointment.room_access_status !== 'ALLOWED') {
    return res.status(409).json({
      message: `${appointment.workflow_key} pre-consultation requirements are not complete.`,
      workflowKey: appointment.workflow_key,
      intakeStatus: appointment.intake_status,
      providerClearanceStatus: appointment.provider_clearance_status,
      code: 'WORKFLOW_BLOCKED'
    });
  }

  const now = new Date(appointment.database_now);
  if (now < new Date(appointment.opens_at)) {
    return res.status(409).json({
      message: `Room opens at ${new Date(appointment.opens_at).toLocaleString('en-ZA')}.`,
      opensAt: appointment.opens_at
    });
  }
  if (now > new Date(appointment.closes_at)) {
    return res.status(410).json({ message: 'This consultation room has closed.' });
  }

  await pool.query(
    `UPDATE consultation_rooms SET status='OPEN' WHERE id=$1 AND status='READY'`,
    [appointment.room_id]
  );
  await pool.query(
    `INSERT INTO consultation_room_events(room_id,user_id,event_type,metadata)
     VALUES($1,$2,'JOIN_TOKEN_ISSUED',$3::jsonb)`,
    [appointment.room_id, req.user.sub, JSON.stringify({ workflowKey: appointment.workflow_key })]
  );

  res.json({
    room: {
      id: appointment.room_id,
      appointmentId: appointment.appointment_id,
      roomCode: appointment.room_code,
      serviceName: appointment.service_name,
      startsAt: appointment.starts_at,
      endsAt: appointment.ends_at,
      clientName: `${appointment.client_first_name} ${appointment.client_last_name}`,
      providerName: `${appointment.provider_first_name} ${appointment.provider_last_name}`,
      workflowKey: appointment.workflow_key
    },
    roomToken: signRoomToken({
      userId: req.user.sub,
      appointmentId: appointment.appointment_id,
      roomId: appointment.room_id,
      role: req.user.role
    })
  });
}));

module.exports = router;
