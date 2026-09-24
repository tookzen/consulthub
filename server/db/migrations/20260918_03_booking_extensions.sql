ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_status_check;
ALTER TABLE appointments ADD CONSTRAINT appointments_status_check
  CHECK (status IN ('PENDING','CONFIRMED','COMPLETED','CANCELLED','EXPIRED','NO_SHOW'));

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='appointments_recurring_series_fk') THEN
    ALTER TABLE appointments ADD CONSTRAINT appointments_recurring_series_fk FOREIGN KEY (recurring_series_id) REFERENCES recurring_booking_series(id) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
