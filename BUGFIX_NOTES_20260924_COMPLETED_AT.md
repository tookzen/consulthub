# Appointment completed_at migration fix

The ratings/history seed inserts a historical completed appointment and sets `appointments.completed_at`. Earlier schemas did not create that column.

This release adds migration:

`server/db/migrations/20260924_07_appointment_completion.sql`

It:
- adds `appointments.completed_at TIMESTAMPTZ` safely with `IF NOT EXISTS`;
- backfills existing completed appointments using their previous `updated_at`/`ends_at` values;
- adds a partial index for completed appointment queries.

The appointment completion route now also sets `completed_at` the first time a provider completes an appointment.

Upgrade commands:

```powershell
cd server
npm run db:migrate
npm run db:seed
npm run test:db
npm run dev
```
