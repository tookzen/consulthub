# Bug fix — Provider Client cases & history

## Symptom
Provider navigation to **Client cases & history** returned `Unexpected server error.`

## Root cause
`GET /api/cases/mine` used PostgreSQL placeholder `$2` for the provider id while `$1` was unused, but still passed two parameters. PostgreSQL cannot resolve an unused prepared-statement parameter type and rejects the query.

## Fix
The provider cases query now uses `$1` consistently and passes only `[provider.id]`.

No database migration is required for this fix.
