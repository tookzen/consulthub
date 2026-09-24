# Bug fix - PostgreSQL timestamptz seed/reschedule arithmetic

Fixed PostgreSQL error 42804 (`opens_at is timestamp with time zone but expression is interval`) by explicitly casting prepared statement parameters to `timestamptz` before adding/subtracting intervals.

Affected files:
- `server/scripts/seed.js`
- `server/src/routes/appointments.js`

After updating, run:

```powershell
cd server
npm run db:migrate
npm run db:seed
npm run dev
```
