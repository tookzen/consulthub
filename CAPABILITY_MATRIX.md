# ConsultHub capability matrix

## Implemented in this development build

| Area | Status | Notes |
|---|---|---|
| Email verification | Implemented | Demo delivery; codes can be exposed in development |
| Password reset | Implemented | Code challenge + session revocation |
| Mobile OTP | Implemented | SMS demo channel |
| Provider/admin second factor | Implemented | Email/SMS demo OTP required at login |
| Access/refresh tokens | Implemented | Access token memory-only; rotating HTTP-only refresh cookie |
| Device/session history | Implemented | Revoke sessions/devices from Security Centre |
| Rate limiting/lockouts | Implemented | In-process limiter + 15-minute account lock after repeated failures |
| Passkeys/WebAuthn | Not implemented | Deliberately not faked; requires standards-compliant WebAuthn server/client implementation |
| Weekly provider calendar | Implemented | Multiple windows/day, timezone, blocks, buffers, notice/horizon |
| Google/Outlook calendar | Demo connection only | OAuth and event/busy-time sync are not implemented |
| Booking holds/idempotency | Implemented | 10-minute holds, advisory locks, exclusion constraint |
| Reschedule/cancel/no-show | Implemented | Includes cancellation/refund rules and no-show records |
| Waiting list | Implemented | API + client UI for no-slot scenario |
| Recurring booking series | Data/API foundation | Series definition exists; occurrence generation/payment automation remains future work |
| Demo payments | Implemented | No real money processed |
| Invoices/refunds | Implemented | Generated from demo payment lifecycle |
| Provider earnings/payouts | Implemented | Demo ledger and demo payout |
| Configurable platform fees | Implemented | Admin-managed fee rule table and console |
| Real PayFast/Stripe | Not implemented | Adapter/integration milestone |
| Built-in consultation room | Implemented | WebRTC + WebSocket signaling + signed room tokens |
| TURN infrastructure | Not included | Required for production-grade call reliability |
| Medical workflow | Implemented | Telehealth intake/consent gate + separate medical record |
| Legal workflow | Implemented | Matter intake + parties + provider conflict clearance + separate legal record |
| IT workflow | Implemented | Requirements/scope intake + separate technology record |
| Generic workflow | Implemented | For categories without a specialist module |
| Secure documents | Development implementation | Private local vault, signed download token, access log, simulated malware scan |
| Production object storage | Not implemented | Replace local vault with private S3/object store, KMS, real malware scanning |
| Consent/privacy requests | Implemented | Consent ledger, access/correction/export/deletion-style requests |
| Breach cases | Implemented | User report + compliance-admin incident workflow |
| Professional verification | Mock + production adapter contract | Mock works locally; production mode requires contracted endpoint/API keys |
| Scheduled re-verification | Implemented | Checks due professional registrations and can suspend/escalate failures |
| Admin RBAC | Implemented | SUPER, VERIFICATION, SUPPORT, FINANCE, COMPLIANCE roles |
| Notification queue | Implemented | In-app + demo email/SMS jobs; worker/retry state |
| Reviews | Implemented | Completed appointment only + moderation + provider response API |
| Practice/business accounts | Implemented foundation | Organisation + team members and roles |
| Subscriptions | Data model only | Subscription table exists; checkout/plan UI not implemented |
| Service request marketplace | Implemented | Client posts, provider claim/quote, timeout, re-pool/exclusion |
| Structured request logs | Implemented | Request IDs and JSON request/error logs |
| Immutable-style audit events | Implemented | Sensitive platform changes have append-only event records |
| Versioned migrations | Implemented | Checksum-tracked SQL migration runner |
| Dev/staging/prod examples | Implemented | Separate example environment configuration files |
| Automated tests | Partial | Verification adapters + domain rules + database smoke test; full E2E remains future work |


| Profession-aware document uploads | Implemented | Medical injury images/reports/scripts; legal client/provider documents; technical/general artifacts |
| Case-scoped client history | Implemented | Own-provider history plus approved case history |
| Client-approved provider handover | Implemented | Successor access is case-scoped and requires client decision |
| Local development document backup | Implemented | Second local copy + hash; not off-site/disaster-recovery backup |
| Consultation recording | Development implementation | Both participants must consent; browser MediaRecorder uploads WebM into secure vault |
| Recording consent ledger | Implemented | Grant/revoke events stored and audited |
| Live transcript | Browser demo | Web Speech API; participants each capture local speech; not production-safe for confidential data |
| Production transcription service | Not implemented | Requires approved processor, credentials, security/privacy review and retention controls |

## Production gates

Before real patients, legal clients, identity documents or money are used, replace all demo integrations, add WebAuthn/passkeys if desired, deploy private object storage and TURN, use a distributed rate limiter/job queue, complete external security/privacy review, add backups/disaster recovery, and execute full integration/E2E/load/security testing.

## Ratings and alert counts

| Capability | Status | Notes |
|---|---|---|
| 1-5 star client rating | Implemented | Restricted to completed appointments owned by the client |
| Client public comment | Implemented | Up to 2,000 characters; moderation required before public display |
| Provider average rating | Implemented | Calculated from approved reviews only |
| Provider public review list | Implemented | Shows approved client comments and professional responses |
| Review moderation | Implemented | Admin can approve/hide/reject; client receives status notification |
| Global unread notification badge | Implemented | Clients, providers and admins; database-wide unread count |
| Notification auto-refresh | Implemented | 15-second polling plus browser-focus refresh |
