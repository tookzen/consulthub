CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  phone VARCHAR(50),
  password_hash TEXT NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('CLIENT', 'PROVIDER', 'ADMIN')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS service_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(120) UNIQUE NOT NULL,
  slug VARCHAR(120) UNIQUE NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS provider_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id UUID REFERENCES service_categories(id),
  profession VARCHAR(120) NOT NULL,
  registration_number VARCHAR(120),
  biography TEXT,
  years_experience INTEGER NOT NULL DEFAULT 0 CHECK (years_experience >= 0),
  city VARCHAR(120),
  country VARCHAR(120) DEFAULT 'South Africa',
  verification_status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
  verification_submitted_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  verified_by UUID REFERENCES users(id),
  rejection_reason TEXT,
  suspension_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE provider_profiles ADD COLUMN IF NOT EXISTS verification_submitted_at TIMESTAMPTZ;
ALTER TABLE provider_profiles ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE provider_profiles ADD COLUMN IF NOT EXISTS verified_by UUID REFERENCES users(id);
ALTER TABLE provider_profiles ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
ALTER TABLE provider_profiles ADD COLUMN IF NOT EXISTS suspension_reason TEXT;
ALTER TABLE provider_profiles DROP CONSTRAINT IF EXISTS provider_profiles_verification_status_check;
ALTER TABLE provider_profiles ADD CONSTRAINT provider_profiles_verification_status_check
  CHECK (verification_status IN ('PENDING', 'VERIFIED', 'REJECTED', 'SUSPENDED'));

CREATE TABLE IF NOT EXISTS provider_services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES provider_profiles(id) ON DELETE CASCADE,
  name VARCHAR(150) NOT NULL,
  description TEXT,
  duration_minutes INTEGER NOT NULL DEFAULT 30 CHECK (duration_minutes BETWEEN 10 AND 480),
  price NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  currency VARCHAR(10) NOT NULL DEFAULT 'ZAR',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS provider_availability (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES provider_profiles(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  CHECK (start_time < end_time),
  UNIQUE(provider_id, day_of_week, start_time, end_time)
);

CREATE TABLE IF NOT EXISTS appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_user_id UUID NOT NULL REFERENCES users(id),
  provider_id UUID NOT NULL REFERENCES provider_profiles(id),
  service_id UUID NOT NULL REFERENCES provider_services(id),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('PENDING', 'CONFIRMED', 'COMPLETED', 'CANCELLED')),
  client_notes TEXT,
  meeting_url TEXT,
  payment_status VARCHAR(30) NOT NULL DEFAULT 'UNPAID' CHECK (payment_status IN ('UNPAID', 'PAID', 'REFUNDED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (starts_at < ends_at)
);

-- Verification subsystem -----------------------------------------------------
CREATE TABLE IF NOT EXISTS identity_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES provider_profiles(id) ON DELETE CASCADE,
  legal_first_name VARCHAR(100) NOT NULL,
  legal_last_name VARCHAR(100) NOT NULL,
  id_type VARCHAR(30) NOT NULL DEFAULT 'SA_ID',
  id_number_last4 VARCHAR(8),
  document_reference TEXT NOT NULL,
  selfie_reference TEXT NOT NULL,
  provider_name VARCHAR(100) NOT NULL,
  provider_reference VARCHAR(150) NOT NULL,
  document_authentic BOOLEAN NOT NULL DEFAULT FALSE,
  liveness_passed BOOLEAN NOT NULL DEFAULT FALSE,
  face_match_passed BOOLEAN NOT NULL DEFAULT FALSE,
  confidence NUMERIC(5,4),
  status VARCHAR(20) NOT NULL CHECK (status IN ('PENDING','VERIFIED','REJECTED','SUSPENDED')),
  checked_at TIMESTAMPTZ,
  raw_result JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS professional_registrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES provider_profiles(id) ON DELETE CASCADE,
  regulatory_body VARCHAR(100) NOT NULL,
  registration_number VARCHAR(120) NOT NULL,
  registration_category VARCHAR(150),
  registration_status VARCHAR(80),
  name_match BOOLEAN NOT NULL DEFAULT FALSE,
  source VARCHAR(120) NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('PENDING','VERIFIED','REJECTED','SUSPENDED')),
  verified_at TIMESTAMPTZ,
  next_verification_at TIMESTAMPTZ,
  raw_result JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS professional_qualifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES provider_profiles(id) ON DELETE CASCADE,
  institution VARCHAR(255) NOT NULL,
  qualification_name VARCHAR(255) NOT NULL,
  qualification_number VARCHAR(120),
  year_awarded INTEGER CHECK (year_awarded IS NULL OR year_awarded BETWEEN 1900 AND 2200),
  country VARCHAR(120) NOT NULL DEFAULT 'South Africa',
  document_reference TEXT NOT NULL,
  verification_source VARCHAR(150),
  verification_reference VARCHAR(150),
  status VARCHAR(20) NOT NULL CHECK (status IN ('PENDING','VERIFIED','REJECTED','SUSPENDED')),
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS verification_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES provider_profiles(id) ON DELETE CASCADE,
  document_type VARCHAR(80) NOT NULL,
  storage_reference TEXT NOT NULL,
  original_filename VARCHAR(255),
  content_hash VARCHAR(128),
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','VERIFIED','REJECTED','SUSPENDED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS provider_verification_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES provider_profiles(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id),
  event_type VARCHAR(100) NOT NULL,
  from_status VARCHAR(30),
  to_status VARCHAR(30),
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_verification_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES provider_profiles(id) ON DELETE CASCADE,
  admin_user_id UUID NOT NULL REFERENCES users(id),
  decision VARCHAR(20) NOT NULL CHECK (decision IN ('PENDING','VERIFIED','REJECTED','SUSPENDED')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_provider_profiles_category ON provider_profiles(category_id);
CREATE INDEX IF NOT EXISTS idx_provider_profiles_verification ON provider_profiles(verification_status);
CREATE INDEX IF NOT EXISTS idx_provider_services_provider ON provider_services(provider_id);
CREATE INDEX IF NOT EXISTS idx_appointments_client ON appointments(client_user_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_appointments_provider ON appointments(provider_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_identity_verifications_provider ON identity_verifications(provider_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_professional_registrations_provider ON professional_registrations(provider_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_qualifications_provider ON professional_qualifications(provider_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_verification_history_provider ON provider_verification_history(provider_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_active_slot
  ON appointments(provider_id, starts_at)
  WHERE status IN ('PENDING', 'CONFIRMED');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'appointments_no_provider_overlap'
  ) THEN
    ALTER TABLE appointments
      ADD CONSTRAINT appointments_no_provider_overlap
      EXCLUDE USING gist (
        provider_id WITH =,
        tstzrange(starts_at, ends_at, '[)') WITH &&
      )
      WHERE (status IN ('PENDING', 'CONFIRMED'));
  END IF;
END $$;

-- Next-stage platform hardening ------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_method VARCHAR(30);

CREATE TABLE IF NOT EXISTS auth_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  challenge_type VARCHAR(40) NOT NULL CHECK (challenge_type IN ('EMAIL_VERIFY','MFA_LOGIN','PASSWORD_RESET')),
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS refresh_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  user_agent TEXT,
  ip_address INET,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS security_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  event_type VARCHAR(80) NOT NULL,
  severity VARCHAR(20) NOT NULL DEFAULT 'INFO' CHECK (severity IN ('INFO','LOW','MEDIUM','HIGH','CRITICAL')),
  ip_address INET,
  user_agent TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS provider_calendar_settings (
  provider_id UUID PRIMARY KEY REFERENCES provider_profiles(id) ON DELETE CASCADE,
  timezone VARCHAR(80) NOT NULL DEFAULT 'Africa/Johannesburg',
  slot_increment_minutes INTEGER NOT NULL DEFAULT 15 CHECK (slot_increment_minutes BETWEEN 5 AND 120),
  minimum_notice_minutes INTEGER NOT NULL DEFAULT 120 CHECK (minimum_notice_minutes BETWEEN 0 AND 43200),
  maximum_advance_days INTEGER NOT NULL DEFAULT 60 CHECK (maximum_advance_days BETWEEN 1 AND 365),
  buffer_before_minutes INTEGER NOT NULL DEFAULT 0 CHECK (buffer_before_minutes BETWEEN 0 AND 120),
  buffer_after_minutes INTEGER NOT NULL DEFAULT 10 CHECK (buffer_after_minutes BETWEEN 0 AND 120),
  cancellation_notice_hours INTEGER NOT NULL DEFAULT 4 CHECK (cancellation_notice_hours BETWEEN 0 AND 720),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS provider_calendar_blocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES provider_profiles(id) ON DELETE CASCADE,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  reason VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (starts_at < ends_at)
);

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS booking_reference VARCHAR(30);
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(120);
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS hold_expires_at TIMESTAMPTZ;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS cancelled_by UUID REFERENCES users(id);
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS rescheduled_from UUID REFERENCES appointments(id);
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_status_check;
ALTER TABLE appointments ADD CONSTRAINT appointments_status_check
  CHECK (status IN ('PENDING','CONFIRMED','COMPLETED','CANCELLED','EXPIRED'));
ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_payment_status_check;
ALTER TABLE appointments ADD CONSTRAINT appointments_payment_status_check
  CHECK (payment_status IN ('UNPAID','PENDING','PAID','FAILED','REFUNDED'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_appointments_idempotency
  ON appointments(client_user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_appointments_booking_reference
  ON appointments(booking_reference)
  WHERE booking_reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id UUID NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  client_user_id UUID NOT NULL REFERENCES users(id),
  provider_id UUID NOT NULL REFERENCES provider_profiles(id),
  payment_reference VARCHAR(50) UNIQUE NOT NULL,
  provider_name VARCHAR(80) NOT NULL DEFAULT 'DEMO_PAYMENTS',
  amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  currency VARCHAR(10) NOT NULL DEFAULT 'ZAR',
  status VARCHAR(30) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PAID','FAILED','REFUNDED')),
  idempotency_key VARCHAR(120),
  paid_at TIMESTAMPTZ,
  refunded_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_idempotency
  ON payments(client_user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_type VARCHAR(80) NOT NULL,
  title VARCHAR(180) NOT NULL,
  message TEXT NOT NULL,
  channel VARCHAR(30) NOT NULL DEFAULT 'IN_APP' CHECK (channel IN ('IN_APP','EMAIL_DEMO','SMS_DEMO')),
  status VARCHAR(30) NOT NULL DEFAULT 'DELIVERED' CHECK (status IN ('QUEUED','DELIVERED','FAILED')),
  related_type VARCHAR(60),
  related_id UUID,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS consultation_rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id UUID UNIQUE NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  room_code VARCHAR(80) UNIQUE NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'READY' CHECK (status IN ('READY','OPEN','CLOSED')),
  opens_at TIMESTAMPTZ NOT NULL,
  closes_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS consultation_room_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES consultation_rooms(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  event_type VARCHAR(60) NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS compliance_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  provider_id UUID REFERENCES provider_profiles(id) ON DELETE SET NULL,
  case_type VARCHAR(80) NOT NULL,
  priority VARCHAR(20) NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  status VARCHAR(30) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_REVIEW','RESOLVED','CLOSED')),
  summary VARCHAR(255) NOT NULL,
  details TEXT,
  assigned_admin_id UUID REFERENCES users(id) ON DELETE SET NULL,
  resolution_notes TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_challenges_user ON auth_challenges(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_refresh_sessions_user ON refresh_sessions(user_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_created ON security_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_calendar_blocks_provider ON provider_calendar_blocks(provider_id, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS idx_payments_appointment ON payments(appointment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_compliance_cases_status ON compliance_cases(status, priority, created_at DESC);

ALTER TABLE provider_profiles ADD COLUMN IF NOT EXISTS accepting_service_requests BOOLEAN NOT NULL DEFAULT TRUE;

-- Client service-request marketplace ------------------------------------------
CREATE TABLE IF NOT EXISTS service_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_reference VARCHAR(40) UNIQUE NOT NULL,
  client_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES service_categories(id),
  title VARCHAR(180) NOT NULL,
  description TEXT NOT NULL,
  budget_min NUMERIC(12,2) CHECK (budget_min IS NULL OR budget_min >= 0),
  budget_max NUMERIC(12,2) CHECK (budget_max IS NULL OR budget_max >= 0),
  currency VARCHAR(10) NOT NULL DEFAULT 'ZAR',
  preferred_start_at TIMESTAMPTZ,
  provider_action_minutes INTEGER NOT NULL DEFAULT 60 CHECK (provider_action_minutes BETWEEN 5 AND 1440),
  status VARCHAR(30) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLAIMED','QUOTED','ACCEPTED','PROVIDER_TIMEOUT','CANCELLED','COMPLETED')),
  assigned_provider_id UUID REFERENCES provider_profiles(id) ON DELETE SET NULL,
  provider_claimed_at TIMESTAMPTZ,
  provider_action_deadline_at TIMESTAMPTZ,
  accepted_quote_id UUID,
  pool_round INTEGER NOT NULL DEFAULT 1 CHECK (pool_round >= 1),
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (budget_min IS NULL OR budget_max IS NULL OR budget_min <= budget_max)
);

CREATE TABLE IF NOT EXISTS service_request_quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_request_id UUID NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
  provider_id UUID NOT NULL REFERENCES provider_profiles(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  currency VARCHAR(10) NOT NULL DEFAULT 'ZAR',
  message TEXT,
  estimated_duration_minutes INTEGER CHECK (estimated_duration_minutes IS NULL OR estimated_duration_minutes BETWEEN 5 AND 10080),
  valid_until TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED','ACCEPTED','REJECTED','WITHDRAWN')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS service_request_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_request_id UUID NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  event_type VARCHAR(80) NOT NULL,
  from_status VARCHAR(30),
  to_status VARCHAR(30),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS service_request_provider_exclusions (
  service_request_id UUID NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
  provider_id UUID NOT NULL REFERENCES provider_profiles(id) ON DELETE CASCADE,
  reason VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(service_request_id, provider_id)
);

CREATE INDEX IF NOT EXISTS idx_service_requests_client ON service_requests(client_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_service_requests_pool ON service_requests(category_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_service_requests_provider ON service_requests(assigned_provider_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_service_requests_deadline ON service_requests(status, provider_action_deadline_at)
  WHERE status='CLAIMED';
CREATE INDEX IF NOT EXISTS idx_service_request_quotes_request ON service_request_quotes(service_request_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_service_request_events_request ON service_request_events(service_request_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_service_request_exclusions_provider ON service_request_provider_exclusions(provider_id, service_request_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_service_request_active_quote
  ON service_request_quotes(service_request_id, provider_id)
  WHERE status='SUBMITTED';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='service_requests_accepted_quote_fk') THEN
    ALTER TABLE service_requests
      ADD CONSTRAINT service_requests_accepted_quote_fk
      FOREIGN KEY (accepted_quote_id) REFERENCES service_request_quotes(id) ON DELETE SET NULL;
  END IF;
END $$;
