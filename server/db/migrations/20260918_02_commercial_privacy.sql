-- Payments, documents, privacy, reviews, organisations, auditability and reliability.

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_channel_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_channel_check CHECK (channel IN ('IN_APP','EMAIL_DEMO','SMS_DEMO','WHATSAPP_DEMO'));

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS no_show_by VARCHAR(20) CHECK (no_show_by IS NULL OR no_show_by IN ('CLIENT','PROVIDER','BOTH'));
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS no_show_recorded_at TIMESTAMPTZ;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS recurring_series_id UUID;

ALTER TABLE payments ADD COLUMN IF NOT EXISTS platform_fee_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS gateway_fee_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider_net_amount NUMERIC(12,2);

CREATE TABLE IF NOT EXISTS payment_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  event_type VARCHAR(80) NOT NULL,
  provider_event_id VARCHAR(180),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id UUID UNIQUE REFERENCES appointments(id) ON DELETE SET NULL,
  client_user_id UUID NOT NULL REFERENCES users(id),
  provider_id UUID NOT NULL REFERENCES provider_profiles(id),
  invoice_number VARCHAR(60) UNIQUE NOT NULL,
  subtotal NUMERIC(12,2) NOT NULL,
  platform_fee NUMERIC(12,2) NOT NULL DEFAULT 0,
  total NUMERIC(12,2) NOT NULL,
  currency VARCHAR(10) NOT NULL DEFAULT 'ZAR',
  status VARCHAR(30) NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('DRAFT','ISSUED','PAID','VOID','REFUNDED')),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES payments(id),
  appointment_id UUID REFERENCES appointments(id),
  refund_reference VARCHAR(60) UNIQUE NOT NULL,
  amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  currency VARCHAR(10) NOT NULL DEFAULT 'ZAR',
  reason TEXT,
  status VARCHAR(30) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','COMPLETED','FAILED')),
  requested_by UUID REFERENCES users(id),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS provider_payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES provider_profiles(id),
  payout_reference VARCHAR(60) UNIQUE NOT NULL,
  amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  currency VARCHAR(10) NOT NULL DEFAULT 'ZAR',
  status VARCHAR(30) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSING','PAID','FAILED','HELD')),
  period_start DATE,
  period_end DATE,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS provider_earnings_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES provider_profiles(id),
  appointment_id UUID REFERENCES appointments(id),
  payment_id UUID REFERENCES payments(id),
  entry_type VARCHAR(40) NOT NULL CHECK (entry_type IN ('EARNING','REFUND','PAYOUT','ADJUSTMENT')),
  amount NUMERIC(12,2) NOT NULL,
  currency VARCHAR(10) NOT NULL DEFAULT 'ZAR',
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS secure_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES users(id),
  provider_id UUID REFERENCES provider_profiles(id),
  appointment_id UUID REFERENCES appointments(id),
  legal_matter_id UUID REFERENCES legal_matters(id),
  document_type VARCHAR(80) NOT NULL,
  classification VARCHAR(40) NOT NULL DEFAULT 'CONFIDENTIAL' CHECK (classification IN ('INTERNAL','CONFIDENTIAL','MEDICAL','LEGAL_PRIVILEGED','IDENTITY')),
  original_filename VARCHAR(255) NOT NULL,
  content_type VARCHAR(160),
  size_bytes BIGINT,
  storage_provider VARCHAR(40) NOT NULL DEFAULT 'LOCAL_DEMO',
  storage_key TEXT NOT NULL,
  content_hash VARCHAR(128),
  malware_scan_status VARCHAR(30) NOT NULL DEFAULT 'PENDING' CHECK (malware_scan_status IN ('PENDING','CLEAN','QUARANTINED','FAILED')),
  encrypted BOOLEAN NOT NULL DEFAULT TRUE,
  version_number INTEGER NOT NULL DEFAULT 1,
  parent_document_id UUID REFERENCES secure_documents(id),
  retention_until TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS document_access_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES secure_documents(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(30) NOT NULL CHECK (action IN ('UPLOAD','VIEW','DOWNLOAD','DELETE','REPLACE','SCAN')),
  ip_address INET,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS consent_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  appointment_id UUID REFERENCES appointments(id) ON DELETE CASCADE,
  consent_type VARCHAR(80) NOT NULL,
  policy_version VARCHAR(40) NOT NULL,
  granted BOOLEAN NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  withdrawn_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS privacy_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  request_type VARCHAR(40) NOT NULL CHECK (request_type IN ('ACCESS','CORRECTION','EXPORT','DELETION','RESTRICTION','OBJECTION')),
  status VARCHAR(30) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_REVIEW','COMPLETED','REJECTED')),
  details TEXT,
  resolution_notes TEXT,
  assigned_admin_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS breach_incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_reference VARCHAR(60) UNIQUE NOT NULL,
  severity VARCHAR(20) NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  status VARCHAR(30) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CONTAINED','INVESTIGATING','RESOLVED','CLOSED')),
  summary VARCHAR(255) NOT NULL,
  details TEXT,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reported_by UUID REFERENCES users(id),
  assigned_admin_id UUID REFERENCES users(id),
  regulator_notification_required BOOLEAN,
  subject_notification_required BOOLEAN,
  containment_notes TEXT,
  resolution_notes TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notification_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id UUID REFERENCES notifications(id) ON DELETE CASCADE,
  channel VARCHAR(30) NOT NULL CHECK (channel IN ('EMAIL_DEMO','SMS_DEMO','WHATSAPP_DEMO')),
  payload JSONB NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','PROCESSING','DELIVERED','FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id UUID UNIQUE NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  client_user_id UUID NOT NULL REFERENCES users(id),
  provider_id UUID NOT NULL REFERENCES provider_profiles(id),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  review_text TEXT,
  moderation_status VARCHAR(30) NOT NULL DEFAULT 'PENDING' CHECK (moderation_status IN ('PENDING','APPROVED','REJECTED','HIDDEN')),
  professional_response TEXT,
  professional_responded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  organization_type VARCHAR(60) NOT NULL CHECK (organization_type IN ('MEDICAL_PRACTICE','LAW_FIRM','CONSULTANCY','ACCOUNTING_FIRM','EDUCATION_PROVIDER','OTHER')),
  registration_number VARCHAR(120),
  billing_email VARCHAR(255),
  verification_status VARCHAR(30) NOT NULL DEFAULT 'PENDING' CHECK (verification_status IN ('PENDING','VERIFIED','REJECTED','SUSPENDED')),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS organization_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  member_role VARCHAR(40) NOT NULL CHECK (member_role IN ('OWNER','PRACTICE_ADMIN','PROVIDER','RECEPTIONIST','BILLING')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id,user_id)
);

CREATE TABLE IF NOT EXISTS organization_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name VARCHAR(160) NOT NULL,
  address_line1 VARCHAR(255),
  city VARCHAR(120),
  province VARCHAR(120),
  country VARCHAR(120) NOT NULL DEFAULT 'South Africa',
  timezone VARCHAR(80) NOT NULL DEFAULT 'Africa/Johannesburg',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS platform_fee_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(120) UNIQUE NOT NULL,
  percentage NUMERIC(6,3) NOT NULL DEFAULT 0 CHECK (percentage BETWEEN 0 AND 100),
  fixed_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency VARCHAR(10) NOT NULL DEFAULT 'ZAR',
  category_id UUID REFERENCES service_categories(id),
  effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_to TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID REFERENCES provider_profiles(id),
  organization_id UUID REFERENCES organizations(id),
  plan_code VARCHAR(60) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('TRIAL','ACTIVE','PAST_DUE','CANCELLED','EXPIRED')),
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency VARCHAR(10) NOT NULL DEFAULT 'ZAR',
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((provider_id IS NOT NULL) <> (organization_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS recurring_booking_series (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_user_id UUID NOT NULL REFERENCES users(id),
  provider_id UUID NOT NULL REFERENCES provider_profiles(id),
  service_id UUID NOT NULL REFERENCES provider_services(id),
  recurrence_rule TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS waiting_list_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_user_id UUID NOT NULL REFERENCES users(id),
  provider_id UUID NOT NULL REFERENCES provider_profiles(id),
  service_id UUID NOT NULL REFERENCES provider_services(id),
  preferred_date DATE,
  preferred_window VARCHAR(80),
  status VARCHAR(30) NOT NULL DEFAULT 'WAITING' CHECK (status IN ('WAITING','NOTIFIED','BOOKED','EXPIRED','CANCELLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS external_calendar_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES provider_profiles(id) ON DELETE CASCADE,
  provider_name VARCHAR(30) NOT NULL CHECK (provider_name IN ('GOOGLE','OUTLOOK')),
  external_account VARCHAR(255),
  token_reference TEXT,
  sync_status VARCHAR(30) NOT NULL DEFAULT 'NOT_CONNECTED' CHECK (sync_status IN ('NOT_CONNECTED','CONNECTED','ERROR','REAUTH_REQUIRED')),
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  event_type VARCHAR(100) NOT NULL,
  entity_type VARCHAR(80) NOT NULL,
  entity_id UUID,
  action VARCHAR(80) NOT NULL,
  before_state JSONB,
  after_state JSONB,
  ip_address INET,
  user_agent TEXT,
  correlation_id VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_events_payment ON payment_events(payment_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_earnings_provider ON provider_earnings_ledger(provider_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_secure_documents_appointment ON secure_documents(appointment_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_document_access_document ON document_access_logs(document_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_consent_user ON consent_records(user_id,consent_type,granted_at DESC);
CREATE INDEX IF NOT EXISTS idx_privacy_requests_status ON privacy_requests(status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_jobs_status ON notification_jobs(status,available_at);
CREATE INDEX IF NOT EXISTS idx_reviews_provider ON reviews(provider_id,moderation_status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_entity ON audit_events(entity_type,entity_id,created_at DESC);
