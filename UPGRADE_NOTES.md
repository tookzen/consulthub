# ConsultHub profession-aware release notes

This release upgrades the marketplace/hardened MVP with profession-specific workflows and broader platform infrastructure.

## New database migrations

- `20260918_01_profession_workflows.sql`
- `20260918_02_commercial_privacy.sql`
- `20260918_03_booking_extensions.sql`
- `20260918_04_provider_discovery.sql`

Run:

```powershell
cd server
npm install
npm run db:migrate
npm run db:seed
npm run test
npm run test:db
npm run dev
```

The migration runner is versioned/checksum-tracked, so future schema changes should be new files rather than edits to already-applied migration files.

## Major additions

- MEDICAL, LEGAL, TECHNOLOGY and GENERAL appointment workflow state.
- Medical intake/consent and clinical records.
- Legal matters, parties, conflict clearance and legal records.
- Technology requirements and technical consultation records.
- Memory-only browser access token + rotating HTTP-only refresh session.
- Mobile verification demo + device/session history.
- Password reset UI.
- Notification job queue.
- Payment events, invoices, refunds, earnings, payouts and fee rules.
- Private document vault foundation with signed downloads/audit.
- Consent/privacy/breach workflows.
- Practice/business accounts.
- Scoped admin roles and expanded compliance console.
- Scheduled provider registry re-verification.
- Provider discovery filters and approved-only public listing.
- Waiting list, no-show and recurring series foundations.
- External Google/Outlook calendar connection stubs.
- Structured HTTP logs and audit-event store.
- Environment examples for development/staging/production.
- Domain-rule tests and DB smoke test.

## Explicitly still demo/stub

Real payments, real KYC/professional/qualification verification, real email/SMS, Google/Outlook OAuth/event sync, TURN infrastructure, production object storage/malware scanning, subscription checkout and WebAuthn/passkeys.

## 2026-09-22 - Client ratings, comments and global notification counts

### Client feedback
- Clients can rate a provider from 1 to 5 stars after a `COMPLETED` appointment.
- A client can add an optional public comment of up to 2,000 characters.
- Only the client who owns the completed appointment can submit or edit that review.
- Resubmitting a review returns it to `PENDING` moderation.
- Approved reviews are displayed on provider discovery/profile pages and contribute to the public average rating and review count.
- Comments include a reminder not to disclose confidential medical, legal, financial or other sensitive information.
- Providers are notified when new feedback is submitted.
- Clients are notified when an administrator changes review moderation status.
- The provider response API remains available for approved review workflows.

### Notifications
- `GET /api/notifications/unread-count` returns the true unread count across the user's entire notification history.
- `GET /api/notifications` still limits the inbox payload to the latest 100 items, but the count is no longer limited to those 100.
- The React header displays an unread notification badge for every authenticated role: Client, Provider and Admin.
- The badge refreshes on login/session restoration, every 15 seconds, and whenever the browser window regains focus.
- Opening/reading notifications updates the badge immediately.

### Migration
Run:

```powershell
cd server
npm run db:migrate
npm run db:seed
```

Migration `20260922_05_ratings_notifications.sql` adds review/update metadata and indexes for public reviews and unread notifications.

## 2026-09-23 - Case continuity, documents, recording and transcripts

- Added migration `20260923_06_continuity_documents_recordings.sql`.
- Added `consultation_cases`, scoped provider access and client-approved handover requests.
- Providers can see their own prior consultations with the same client; cross-provider history requires an approved case handover.
- Added explicit linking of successor-provider appointments to an existing transferred case.
- Extended secure documents with case linkage, profession-specific purpose, uploader role and backup metadata.
- Development document storage writes a second local backup copy and falls back to it if the primary file is missing. This is not a substitute for off-site production backup.
- Added medical injury/report/lab/prescription/referral document purposes and legal client/evidence/draft/signed-document purposes.
- Added bilateral consultation recording consent, recording metadata and secure WebM upload.
- Added optional browser-demo live transcription and transcript storage/review status.
- WebRTC room time comparison now uses PostgreSQL time returned by the join query, avoiding workstation/server clock skew.

Run:

```powershell
cd server
npm run db:migrate
npm run db:seed
npm run test
npm run test:db
npm run dev
```

Then restart the React client.

