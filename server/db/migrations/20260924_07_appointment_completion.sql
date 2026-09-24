-- Add an explicit completion timestamp to appointments.
-- Seeded historical consultations and review eligibility/reporting use this value.
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

-- Preserve useful history for databases upgraded from earlier ConsultHub builds.
UPDATE appointments
SET completed_at = COALESCE(completed_at, updated_at, ends_at, NOW())
WHERE status = 'COMPLETED'
  AND completed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_appointments_completed_at
  ON appointments(completed_at)
  WHERE completed_at IS NOT NULL;
