ALTER TABLE provider_profiles ADD COLUMN IF NOT EXISTS languages TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE provider_profiles ADD COLUMN IF NOT EXISTS consultation_modes TEXT[] NOT NULL DEFAULT ARRAY['ONLINE']::text[];
CREATE INDEX IF NOT EXISTS idx_provider_profiles_city ON provider_profiles(city);
