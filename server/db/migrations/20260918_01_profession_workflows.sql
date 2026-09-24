-- ConsultHub profession-specific workflows and stronger identity/session controls.

ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ;

ALTER TABLE auth_challenges DROP CONSTRAINT IF EXISTS auth_challenges_challenge_type_check;
ALTER TABLE auth_challenges ADD CONSTRAINT auth_challenges_challenge_type_check
  CHECK (challenge_type IN ('EMAIL_VERIFY','PHONE_VERIFY','MFA_LOGIN','MFA_SMS','PASSWORD_RESET'));

ALTER TABLE refresh_sessions ADD COLUMN IF NOT EXISTS device_id VARCHAR(120);

CREATE TABLE IF NOT EXISTS user_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id VARCHAR(120) NOT NULL,
  device_name VARCHAR(180),
  user_agent TEXT,
  first_ip INET,
  last_ip INET,
  trusted BOOLEAN NOT NULL DEFAULT FALSE,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  UNIQUE(user_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_user_devices_user ON user_devices(user_id,last_seen_at DESC);

CREATE TABLE IF NOT EXISTS admin_role_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  admin_role VARCHAR(40) NOT NULL CHECK (admin_role IN ('SUPER_ADMIN','VERIFICATION_ADMIN','SUPPORT_AGENT','FINANCE_ADMIN','COMPLIANCE_ADMIN')),
  granted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id,admin_role)
);

CREATE TABLE IF NOT EXISTS service_category_workflows (
  category_id UUID PRIMARY KEY REFERENCES service_categories(id) ON DELETE CASCADE,
  workflow_key VARCHAR(40) NOT NULL CHECK (workflow_key IN ('MEDICAL','LEGAL','TECHNOLOGY','GENERAL')),
  display_name VARCHAR(120) NOT NULL,
  preconsultation_requirements JSONB NOT NULL DEFAULT '{}'::jsonb,
  room_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  retention_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS medical_provider_profiles (
  provider_id UUID PRIMARY KEY REFERENCES provider_profiles(id) ON DELETE CASCADE,
  speciality VARCHAR(180),
  practice_name VARCHAR(255),
  practice_number VARCHAR(120),
  hpcsa_practice_category VARCHAR(180),
  emergency_support_ack BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS legal_provider_profiles (
  provider_id UUID PRIMARY KEY REFERENCES provider_profiles(id) ON DELETE CASCADE,
  firm_name VARCHAR(255),
  practitioner_type VARCHAR(120),
  areas_of_practice TEXT[] NOT NULL DEFAULT '{}',
  trust_account_applicable BOOLEAN,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS technology_provider_profiles (
  provider_id UUID PRIMARY KEY REFERENCES provider_profiles(id) ON DELETE CASCADE,
  specialities TEXT[] NOT NULL DEFAULT '{}',
  delivery_modes TEXT[] NOT NULL DEFAULT '{}',
  service_regions TEXT[] NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS appointment_workflows (
  appointment_id UUID PRIMARY KEY REFERENCES appointments(id) ON DELETE CASCADE,
  workflow_key VARCHAR(40) NOT NULL CHECK (workflow_key IN ('MEDICAL','LEGAL','TECHNOLOGY','GENERAL')),
  intake_status VARCHAR(30) NOT NULL DEFAULT 'REQUIRED' CHECK (intake_status IN ('NOT_REQUIRED','REQUIRED','COMPLETE')),
  provider_clearance_status VARCHAR(30) NOT NULL DEFAULT 'NOT_REQUIRED' CHECK (provider_clearance_status IN ('NOT_REQUIRED','PENDING','CLEARED','BLOCKED')),
  room_access_status VARCHAR(30) NOT NULL DEFAULT 'BLOCKED' CHECK (room_access_status IN ('BLOCKED','ALLOWED')),
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS medical_intakes (
  appointment_id UUID PRIMARY KEY REFERENCES appointments(id) ON DELETE CASCADE,
  presenting_concern TEXT NOT NULL,
  symptoms TEXT,
  symptom_duration VARCHAR(180),
  medications TEXT,
  allergies TEXT,
  chronic_conditions TEXT,
  emergency_contact_name VARCHAR(180),
  emergency_contact_phone VARCHAR(80),
  location_during_consult VARCHAR(255),
  emergency_warning_ack BOOLEAN NOT NULL DEFAULT FALSE,
  completed_by UUID NOT NULL REFERENCES users(id),
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS medical_consultation_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id UUID UNIQUE NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  provider_id UUID NOT NULL REFERENCES provider_profiles(id),
  subjective_notes TEXT,
  objective_notes TEXT,
  assessment TEXT,
  plan TEXT,
  follow_up TEXT,
  referral_notes TEXT,
  record_status VARCHAR(30) NOT NULL DEFAULT 'DRAFT' CHECK (record_status IN ('DRAFT','SIGNED','AMENDED')),
  signed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS legal_matters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id UUID UNIQUE NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  matter_reference VARCHAR(60) UNIQUE NOT NULL,
  client_user_id UUID NOT NULL REFERENCES users(id),
  provider_id UUID NOT NULL REFERENCES provider_profiles(id),
  matter_type VARCHAR(160),
  matter_summary TEXT NOT NULL,
  confidentiality_ack BOOLEAN NOT NULL DEFAULT FALSE,
  conflict_status VARCHAR(30) NOT NULL DEFAULT 'PENDING' CHECK (conflict_status IN ('PENDING','CLEAR','POTENTIAL','CONFLICT')),
  conflict_notes TEXT,
  conflict_checked_by UUID REFERENCES users(id),
  conflict_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS legal_matter_parties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_matter_id UUID NOT NULL REFERENCES legal_matters(id) ON DELETE CASCADE,
  party_name VARCHAR(255) NOT NULL,
  party_type VARCHAR(80),
  relationship_to_matter VARCHAR(160),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_legal_matter_party_name ON legal_matter_parties(LOWER(party_name));

CREATE TABLE IF NOT EXISTS legal_consultation_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_matter_id UUID UNIQUE NOT NULL REFERENCES legal_matters(id) ON DELETE CASCADE,
  provider_id UUID NOT NULL REFERENCES provider_profiles(id),
  privileged_notes TEXT,
  advice_summary TEXT,
  next_steps TEXT,
  document_requests TEXT,
  record_status VARCHAR(30) NOT NULL DEFAULT 'DRAFT' CHECK (record_status IN ('DRAFT','SIGNED','AMENDED')),
  signed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS technology_engagements (
  appointment_id UUID PRIMARY KEY REFERENCES appointments(id) ON DELETE CASCADE,
  project_name VARCHAR(255),
  problem_statement TEXT NOT NULL,
  current_environment TEXT,
  desired_outcome TEXT,
  technical_constraints TEXT,
  systems_involved TEXT,
  access_required TEXT,
  client_acceptance_criteria TEXT,
  completed_by UUID NOT NULL REFERENCES users(id),
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS technology_consultation_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id UUID UNIQUE NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  provider_id UUID NOT NULL REFERENCES provider_profiles(id),
  findings TEXT,
  recommendations TEXT,
  deliverables TEXT,
  risks TEXT,
  next_steps TEXT,
  record_status VARCHAR(30) NOT NULL DEFAULT 'DRAFT' CHECK (record_status IN ('DRAFT','SIGNED','AMENDED')),
  signed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_appointment_workflows_workflow ON appointment_workflows(workflow_key,room_access_status);
