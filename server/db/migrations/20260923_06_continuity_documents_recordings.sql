-- Consultation continuity, profession-aware documents, handovers, recording consent and transcripts.

CREATE TABLE IF NOT EXISTS consultation_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_reference VARCHAR(60) UNIQUE NOT NULL,
  client_user_id UUID NOT NULL REFERENCES users(id),
  category_id UUID REFERENCES service_categories(id),
  workflow_key VARCHAR(40) NOT NULL CHECK (workflow_key IN ('MEDICAL','LEGAL','TECHNOLOGY','GENERAL')),
  title VARCHAR(255) NOT NULL,
  summary TEXT,
  originating_provider_id UUID NOT NULL REFERENCES provider_profiles(id),
  current_provider_id UUID NOT NULL REFERENCES provider_profiles(id),
  status VARCHAR(30) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED','ARCHIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS case_id UUID REFERENCES consultation_cases(id);
CREATE INDEX IF NOT EXISTS idx_appointments_case ON appointments(case_id, starts_at DESC);
CREATE INDEX IF NOT EXISTS idx_consultation_cases_client ON consultation_cases(client_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_consultation_cases_provider ON consultation_cases(current_provider_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS case_provider_access (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES consultation_cases(id) ON DELETE CASCADE,
  provider_id UUID NOT NULL REFERENCES provider_profiles(id) ON DELETE CASCADE,
  access_level VARCHAR(30) NOT NULL DEFAULT 'READ_ONLY' CHECK (access_level IN ('ORIGINATING','CURRENT','READ_ONLY')),
  scope JSONB NOT NULL DEFAULT '{"consultations":true,"documents":true,"records":true}'::jsonb,
  granted_by_user_id UUID REFERENCES users(id),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_until TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  UNIQUE(case_id, provider_id)
);

CREATE TABLE IF NOT EXISTS case_handover_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES consultation_cases(id) ON DELETE CASCADE,
  from_provider_id UUID NOT NULL REFERENCES provider_profiles(id),
  to_provider_id UUID NOT NULL REFERENCES provider_profiles(id),
  requested_by_user_id UUID NOT NULL REFERENCES users(id),
  reason TEXT,
  scope JSONB NOT NULL DEFAULT '{"consultations":true,"documents":true,"records":true}'::jsonb,
  status VARCHAR(30) NOT NULL DEFAULT 'PENDING_CLIENT' CHECK (status IN ('PENDING_CLIENT','APPROVED','REJECTED','CANCELLED','EXPIRED')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  client_decision_at TIMESTAMPTZ,
  client_decision_notes TEXT,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_case_handover_client ON case_handover_requests(case_id,status,created_at DESC);

-- Extend the secure document model so evidence/scripts/work product can follow a case.
ALTER TABLE secure_documents ADD COLUMN IF NOT EXISTS case_id UUID REFERENCES consultation_cases(id);
ALTER TABLE secure_documents ADD COLUMN IF NOT EXISTS purpose VARCHAR(80);
ALTER TABLE secure_documents ADD COLUMN IF NOT EXISTS uploaded_role VARCHAR(20) CHECK (uploaded_role IS NULL OR uploaded_role IN ('CLIENT','PROVIDER','ADMIN'));
ALTER TABLE secure_documents ADD COLUMN IF NOT EXISTS backup_key TEXT;
ALTER TABLE secure_documents ADD COLUMN IF NOT EXISTS backup_status VARCHAR(30) NOT NULL DEFAULT 'PENDING' CHECK (backup_status IN ('PENDING','BACKED_UP','FAILED','NOT_REQUIRED'));
CREATE INDEX IF NOT EXISTS idx_secure_documents_case ON secure_documents(case_id, created_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS consultation_recording_consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id UUID NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  decision VARCHAR(20) NOT NULL CHECK (decision IN ('GRANTED','DECLINED','REVOKED')),
  policy_version VARCHAR(40) NOT NULL DEFAULT 'recording-dev-2026-09',
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(appointment_id,user_id)
);

CREATE TABLE IF NOT EXISTS consultation_recordings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id UUID NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  initiated_by UUID NOT NULL REFERENCES users(id),
  recording_type VARCHAR(30) NOT NULL DEFAULT 'AUDIO_VIDEO' CHECK (recording_type IN ('AUDIO_VIDEO','AUDIO_ONLY')),
  status VARCHAR(30) NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED','RECORDING','UPLOADED','FAILED','DELETED')),
  document_id UUID REFERENCES secure_documents(id),
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_ms BIGINT,
  transcript_status VARCHAR(30) NOT NULL DEFAULT 'NOT_REQUESTED' CHECK (transcript_status IN ('NOT_REQUESTED','DRAFT','READY','FAILED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_consultation_recordings_appointment ON consultation_recordings(appointment_id,created_at DESC);

CREATE TABLE IF NOT EXISTS consultation_transcripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id UUID UNIQUE NOT NULL REFERENCES consultation_recordings(id) ON DELETE CASCADE,
  appointment_id UUID NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  language VARCHAR(30) NOT NULL DEFAULT 'en-ZA',
  transcript_text TEXT NOT NULL,
  transcript_source VARCHAR(40) NOT NULL DEFAULT 'BROWSER_DEMO' CHECK (transcript_source IN ('BROWSER_DEMO','MANUAL','EXTERNAL_PROVIDER')),
  status VARCHAR(30) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','READY','REVIEWED')),
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Useful history indexes.
CREATE INDEX IF NOT EXISTS idx_appointments_client_provider_history ON appointments(client_user_id,provider_id,starts_at DESC);
CREATE INDEX IF NOT EXISTS idx_recording_consent_appointment ON consultation_recording_consents(appointment_id,decision);

-- The local development vault is permission-restricted but not cryptographically encrypted at the application layer.
-- Do not mislabel local files as encrypted; production object storage must supply encryption-at-rest.
UPDATE secure_documents SET encrypted=FALSE WHERE storage_provider='LOCAL_DEMO';
