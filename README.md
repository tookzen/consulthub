# ConsultHub — profession-aware consultation platform

ConsultHub is a React + Node.js/Express + PostgreSQL platform for verified online professional services. This release separates shared platform services from profession-specific operational workflows so a medical consultation, legal consultation and IT consultation are no longer treated as the same process.

> Development MVP: demo payment, email/SMS delivery, KYC/registry checks, external calendars and local document storage are not production integrations. See `CAPABILITY_MATRIX.md` before using sensitive or regulated real-world data.

## Architecture

```text
                         ConsultHub core
                Auth / verification / audit / privacy
              Booking / calendar / payments / documents
               Notifications / organisations / reviews
                              |
          +-------------------+-------------------+
          |                   |                   |
       Medical              Legal             Technology
     intake/consent      matter/parties       requirements
     clinical record     conflict check       scope/outcomes
     room gate           legal record         technical record
          +-------------------+-------------------+
                              |
                     Secure consultation room
```

## Key features in this release

- Access JWT is held in browser memory only; refresh session is an HTTP-only rotating cookie.
- Email verification, password reset, mobile OTP demo, second factor for provider/admin logins, device/session history, revocation, login throttling and account lockout.
- Service-specific provider onboarding for Medical, Legal and Technology categories.
- Medical telehealth intake/consent and dedicated clinical record.
- Legal matter intake, parties/conflict-screen workflow and dedicated legal consultation record.
- IT requirements/scope intake and dedicated technology consultation record.
- Consultation rooms are workflow-gated; payment alone is not enough to enter a Medical/Legal/IT room.
- Provider recurring availability, breaks via multiple windows, blocked periods/holidays, timezone, buffers, minimum notice, booking horizon and cancellation notice.
- Demo Google/Outlook calendar connection records for a future OAuth/busy-time sync integration.
- Transaction-safe bookings: temporary holds, idempotency keys, PostgreSQL advisory locks, overlap exclusion constraint, reschedule, cancellation, no-show and waiting-list APIs.
- Demo payment lifecycle plus payment events, invoices, refunds, provider earnings and demo payouts.
- Configurable platform fee rules; commission is not hard-coded into checkout logic.
- Built-in WebRTC consultation rooms with signed appointment-bound room tokens and WebSocket signaling. Optional consent-gated consultation recording and browser-demo transcription are included.
- Profession-aware consultation documents: client/provider uploads for medical evidence, prescriptions/referrals, legal evidence/drafts/signed documents and technical artifacts; signed short-lived downloads, access logs, simulated malware scanning, and a second local development backup copy.
- Consent ledger, privacy requests and breach incident workflows.
- Practice/firm/consultancy accounts with team-member roles.
- Admin RBAC: `SUPER_ADMIN`, `VERIFICATION_ADMIN`, `SUPPORT_AGENT`, `FINANCE_ADMIN`, `COMPLIANCE_ADMIN`.
- Admin queues for verification, users, security, appointments, service requests, payments, refunds, payouts, privacy requests, breach incidents, document access, reviews, compliance cases and audit events.
- Queued notification worker with in-app and demo email/SMS delivery.
- Scheduled professional-registration re-verification.
- Checksum-tracked versioned SQL migrations.
- Structured request/error logs with request IDs.
- Provider discovery filters for category, city, speciality/area, language and maximum starting price; public discovery returns approved professionals only.

## Windows local setup (PostgreSQL installed directly)

### Prerequisites

Install:

1. Visual Studio Code
2. Node.js 20.19+ (Node 22/24 recommended)
3. PostgreSQL 17 or 18
4. pgAdmin 4

Verify:

```powershell
node --version
npm --version
Get-Service *postgres*
```

### 1. Create the database

Create a PostgreSQL database named:

```text
consultation_platform
```

### 2. Server environment

```powershell
cd server
Copy-Item .env.example .env
```

Edit `server/.env`:

```env
NODE_ENV=development
PORT=5000
CLIENT_URL=http://localhost:5173
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/consultation_platform
JWT_SECRET=REPLACE_WITH_A_LONG_RANDOM_SECRET
JWT_EXPIRES_IN=20m
COOKIE_SECURE=false
DEV_EXPOSE_AUTH_CODES=true
VERIFICATION_MODE=MOCK
```

Generate a strong local JWT secret:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### 3. Install, migrate, seed and test server

```powershell
npm install
npm run db:migrate
npm run db:seed
npm run test
npm run test:db
npm run check:syntax
npm run dev
```

`npm run test:db` requires PostgreSQL to be running and validates critical tables.

Health check:

```text
http://localhost:5000/api/health
```

### 4. Start the React client

Open a second terminal:

```powershell
cd client
Copy-Item .env.example .env
npm install
npm run dev
```

Open:

```text
http://localhost:5173
```

## Demo accounts

All seeded accounts use:

```text
Password123!
```

| Role | Email |
|---|---|
| Client | `client@consulthub.local` |
| Medical provider | `doctor@consulthub.local` |
| Second medical provider (handover testing) | `doctor2@consulthub.local` |
| Legal provider | `lawyer@consulthub.local` |
| IT provider | `it@consulthub.local` |
| Pending provider | `pending@consulthub.local` |
| Super administrator | `admin@consulthub.local` |

Seed providers/admins require the demo second-factor code during login. With `DEV_EXPOSE_AUTH_CODES=true`, the UI displays it.

### Test a client-approved medical handover

The seed creates `CASE-DEMO-MEDICAL` for the demo client and `doctor@consulthub.local`. To test continuity of care:

1. Log in as `doctor@consulthub.local`, open **Cases**, choose the seeded medical case and request a handover to `doctor2@consulthub.local`.
2. Log in as `client@consulthub.local`, open **Cases** and approve or reject the pending handover.
3. When approved, the originating doctor remains read-only for the transferred case and the second doctor receives the scoped case access recorded by the handover.
4. A later appointment with the second doctor can be linked to the existing case so approved history and documents stay with the same continuity record.

## Profession workflows

### Medical

```text
Book -> Pay -> Medical intake + telehealth consent -> Room enabled
     -> Consultation -> Clinical record -> Complete
```

The client intake includes presenting concern, relevant information, telehealth consent and emergency/escalation acknowledgement. The provider writes to `medical_consultation_records`, not a generic notes table.

### Legal

```text
Book -> Pay -> Matter intake + parties -> Conflict review by lawyer
     -> CLEAR -> Room enabled -> Legal consultation record
     -> CONFLICT -> Room remains blocked
```

Legal records are stored separately from medical and technology records.

### Technology / IT

```text
Book -> Pay -> Requirements/scope intake -> Room enabled
     -> Technical consultation -> Technical recommendations/deliverables record
```

### General

Categories without a specialised module use the general workflow and can enter a paid/confirmed room without an additional profession-specific intake gate.


## Documents, case continuity, recording and transcripts

### Profession-aware documents

Both participants can upload consultation/case files from the Workflow screen. Medical clients can add injury images/screenshots, reports and lab results; medical providers can add prescriptions, referrals and reports. Legal clients can add contracts/evidence and legal providers can add drafts, signed documents and evidence. Technology/general consultations have equivalent artifact/attachment types.

The development vault stores a primary local copy plus a second local backup copy and records a SHA-256 hash and access events. The local vault is **not application-layer encrypted**; `encrypted=false` is used honestly for local files. Production must replace this with private object storage, encryption-at-rest/KMS, versioning/off-site backup, real malware scanning and retention policy.

### Client/patient history and handover

An appointment can be linked to a `consultation_case`. The assigned provider can see their own prior consultations with that client. Cross-provider history is case-scoped: a handover request names the successor provider and requested scope, the client must approve, and only then is the successor given case history/documents/records. The successor's next appointment can be explicitly linked to the transferred case.

### Recording consent

Recording and transcription require explicit consent from both client and provider for the appointment. Consent/revocation is stored separately and mirrored into the consent ledger. Recording metadata and recordings are restricted to appointment/case participants.

The localhost MVP can create a composite WebM recording in the browser (remote video + local picture-in-picture + mixed audio) and upload it into the secure document vault. This is a development implementation, not a production recording service.

### Transcripts

The room includes an optional browser speech-recognition transcript demo. Each participant can start local speech recognition; transcript fragments are relayed to the peer and can be edited/saved against the recording. Browser speech recognition may use the browser vendor's speech service, so this **must not be treated as the production transcription architecture for confidential consultations**. Production should use an approved transcription processor under the applicable privacy/professional obligations, with retention and access controls.

## Authentication design

- Access token: short-lived JWT, memory-only in the React application.
- Refresh token: random server-side session token in an HTTP-only cookie.
- Refresh tokens rotate on refresh.
- Password reset revokes active refresh sessions.
- Providers and administrators always complete a second-factor challenge in this development build.
- Security Centre shows known devices and refresh sessions and allows revocation.
- Passkeys/WebAuthn are intentionally **not faked**. Add a standards-compliant WebAuthn implementation before claiming passkey support.
- Current API rate limiting is in-process and must be replaced by a distributed store such as Redis when multiple API instances are deployed.

## Verification modes

Local development:

```env
VERIFICATION_MODE=MOCK
```

Production adapter mode:

```env
VERIFICATION_MODE=PRODUCTION
```

Production mode expects contracted/authorised verification endpoints via environment variables. The supplied generic HTTP adapter expects normalised verification JSON; adapt it to the exact contract of the providers you select. No real HPCSA, LPC, qualification or KYC endpoint is embedded in this source tree.

Scheduled registry re-verification checks `professional_registrations.next_verification_at`. A failed check suspends the professional, creates a compliance case and notifies the provider.

## Database migrations

The baseline schema remains in `server/db/schema.sql`. New changes live under:

```text
server/db/migrations/
```

The migration runner records filename + SHA-256 checksum in `schema_migrations`. Do not edit an already-applied migration; create a new migration instead.

## Environments

Examples are included for:

```text
server/.env.development.example
server/.env.staging.example
server/.env.production.example
client/.env.development.example
client/.env.staging.example
client/.env.production.example
```

Never copy production data or production secrets into development.

## Production work still required

At minimum before handling real sensitive data or real money:

- Select and contract real identity/KYC, professional-registry and qualification verification services.
- Replace demo email/SMS notification dispatch with real providers.
- Integrate a real payment gateway and webhook signature validation.
- Replace local secure-document storage with private object storage, encryption/KMS, malware scanning, lifecycle/retention policy and backup.
- Add production TURN infrastructure for WebRTC.
- Add standards-compliant WebAuthn/passkeys if required.
- Use distributed rate limiting and a production queue/worker system.
- Add full end-to-end, concurrency, load, penetration and disaster-recovery tests.
- Complete professional-regulatory, privacy/POPIA, retention, consent and incident-response review for your exact use cases.
- Configure staging and production observability, alerting, encrypted backups and recovery procedures.

See `CAPABILITY_MATRIX.md` for the exact implemented/demo/not-yet-implemented status.

## Client ratings, comments and notification badges

Clients can submit a 1-5 star rating and optional comment after a completed appointment. Reviews enter moderation before they are visible publicly. Approved ratings are aggregated into a provider's public average and review count, and approved comments appear on the provider profile.

The navigation now also shows a live unread-notification count for every authenticated user type (clients, professionals and administrators). The unread count is calculated across all unread notification records, not only the most recent 100 displayed in the inbox.

For a quick demo after seeding, the doctor profile includes one historical approved 5-star review. To test client review entry yourself, complete an appointment as the provider and then open the same appointment from the client dashboard and choose **Rate consultation**.
