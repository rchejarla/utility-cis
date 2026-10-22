# Runbook — Bill Production Slice 1

Deploying the change that turns a posted `Bill` into a stored PDF.

**What is new:** two tables (`bill_message`, `bill_document`), a patched
dependency the API cannot boot without, two environment variables, and
per-tenant settings without which no bill will produce.

Nothing here rewrites existing data. Every failure mode below is a
prerequisite that was missed rather than a change that went wrong — which
is why they are worth listing: two of the three leave the application
looking healthy.

---

## 1. The dependency patch — the one that takes everything down

**This is the highest-consequence item on the page.** The whole
`@react-pdf/*` stack is ESM-only with no CommonJS build. The API package
is CommonJS, and Node resolves a `require`d ESM graph under the `require`
condition — which `@react-pdf/hyphenate@0.1.0` does not declare. Without
the patch, `@react-pdf/textkit`'s reach for `@react-pdf/hyphenate/en-us`
fails and the process exits **before Fastify listens**:

```
Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath './en-us' is not
defined by "exports" in .../@react-pdf/hyphenate/package.json
```

Every endpoint is down, not just bills. There is no partial degradation.

The patch is wired through `pnpm.patchedDependencies` in the root
`package.json` and lives at
`patches/@react-pdf__hyphenate@0.1.0.patch`. It is applied by `pnpm
install`. **Any build path that does not honour that field produces an
API that will not start** — a different package manager, an install that
skips the patch step, or a lockfile out of step with the patch file.

Verify after install, before starting anything:

```bash
node -e "require('@react-pdf/renderer'); console.log('renderer loads')"
```

Run it from `packages/api`. If it prints, the patch took. If it throws
`ERR_PACKAGE_PATH_NOT_EXPORTED`, stop — starting the API will fail.

## 2. Apply the migrations

Forward-only, additive, and they touch no existing rows.

```bash
pnpm --filter @utility-cis/shared exec prisma migrate deploy
```

Applies:

- `20261011120100_bill_message` — creates `bill_message`, with RLS.
- `20261011120300_bill_document` — creates `bill_document`, with RLS, a
  unique index on `(bill_id, document_type)` and an FK to `bill`.

Confirm both tables carry their tenant policy, since a missing policy is
a cross-tenant read rather than an error:

```sql
SELECT tablename, policyname FROM pg_policies
WHERE tablename IN ('bill_message', 'bill_document');
```

Two rows expected. No rows means RLS did not attach and the deploy should
be stopped.

## 3. Environment — silent if missed

```
APPTOR_CONNECT_URL              the files plane base URL
APPTOR_CONNECT_API_KEY          one deployment-level key, ak_...
BILL_DOCUMENT_LINK_TTL_SECONDS  optional, default 300, max 900
BILL_DOCUMENT_MAX_BYTES         optional, default 10485760
```

**Both of the first two default to a local no-op** —
`http://localhost:8080` and an empty string — so a deploy that omits them
boots cleanly, answers `/health` with `ok`, and fails only when somebody
clicks View bill, as a 502. Nothing earlier in the deploy will complain.

The API key is a deployment-level credential and is never stored in the
database. Which object store a given utility's bills land in is per-tenant
configuration (below), not environment.

> **Open provisioning question, carried from the design.** The
> apptor-connect key is tenant-scoped on their side, while this service
> is multi-tenant by `utility_id` and uses one key, selecting each
> utility's store by integration name. Whether each utility should instead
> hold its own apptor-connect key is a decision for the apptor-connect
> side and is not settled here.

## 4. Per-tenant settings — no bill produces without these

Per utility, under `UtilityConfig.settings`, editable at **Settings → Bill
Production**:

- `billDocuments.storageIntegration` — the apptor-connect integration
  name. Absent: every attempt answers 422 `STORAGE_NOT_CONFIGURED`.
- `issuer.*` — the five fields in `REQUIRED_ISSUER_FIELDS`
  (`utilityName`, `remittanceAddressLine1`, `remittanceCity`,
  `remittanceState`, `remittancePostalCode`). Any missing: 422
  `ISSUER_INCOMPLETE`, naming them.

These do not travel with the deploy. A tenant migrated but not configured
has a working application that cannot produce a bill.

> **On a dev machine, `node seed.js` now configures the dev tenant** —
> `dev-files` as the integration plus demo issuer identity — so a reseed
> leaves bill production working. It did not until 2026-10-22: the wipe
> deletes `utility_config` and nothing recreated it, so reseeding
> silently took bill production away from a database where it had been
> set up by hand, and the next attempt answered
> `STORAGE_NOT_CONFIGURED`, which reads like an apptor-connect fault and
> is not one. `dev-files` works against both the real local instance and
> `scripts/fake-files-plane.mjs`, which treats the name as a directory.
>
> **Provisioning a real tenant still creates no config row, deliberately.**
> Every reader copes with its absence — `getAutomationConfig` upserts on
> read, posting falls back to the column defaults, and readiness reports
> the issuer and storage checks as unmet, which is the right answer for a
> tenant nobody has configured yet. An empty row would decide nothing,
> and pre-filling issuer identity would be worse than leaving it blank: a
> remittance address is the one field on a bill that must not be invented.

Accounts also need a customer with a name and a billing address, or that
bill answers 422 `RECIPIENT_INCOMPLETE` — a data condition, not config,
and correct behaviour: a bill with a blank recipient should not be
mailable.

> **Changing `storageIntegration` later does not move documents already
> stored.** Each `bill_document` row records the integration its bytes
> were written to, so after the setting changes, previously generated
> documents keep pointing at the old one. New bills and any forced
> regeneration use the new integration and repair their own row; nothing
> touches historical rows.
>
> This matters because the usual reason to change the setting is that the
> old integration is going away. When it does, every historical download
> answers 502 `STORAGE_UNAVAILABLE` naming the old integration, and the
> only repair in this slice is **Regenerate PDF** on each affected bill,
> one at a time. A bulk re-point is not built.
>
> So: if the old store is being retired, either keep it readable until
> its documents have been regenerated, or accept that bills before the
> switch are not downloadable until someone regenerates them. The bytes
> in the old store are not deleted by any of this — see Rollback, where
> the same fact cuts the other way.

### Follow-up carried out of review

The tenant logo is fetched from `tenantTheme.logoUrl` while a bill
renders, with the request restricted to https and public addresses and
every redirect re-checked (`generate-bill-pdf.ts`). That restriction is
the mitigation, not the fix: the fix is to stop fetching a
tenant-supplied URL at render time and have the logo uploaded as an
`Attachment` instead, which also removes a remote dependency from the
bytes of every bill. Worth doing in the next slice that touches theming.

## 5. Verify

```bash
# the API is up at all — proves step 1
curl -fsS "$API/health"

# a posted bill produces, stores and streams back
curl -fsS -X POST "$API/api/v1/bills/<posted-bill-id>/document" \
  -H "Authorization: Bearer <accounts:EDIT token>" -H 'Content-Type: application/json' -d '{}'
curl -fsS "$API/api/v1/bills/<posted-bill-id>/document" \
  -H "Authorization: Bearer <accounts:VIEW token>" -o /tmp/bill.pdf
head -c 5 /tmp/bill.pdf   # %PDF-
```

The POST's response `sha256` must equal `sha256sum` of the downloaded
file. They are the same bytes; a mismatch means the store returned
something other than what was uploaded.

---

## Rollback

**The schema rolls back cleanly. Stored PDFs do not.**

Rolling the application back to the previous release needs nothing: the
two tables are additive and no earlier code reads them.

To remove them as well — only worth doing if the feature is being
abandoned, not to recover from a bad deploy:

```sql
-- Order matters: bill_document has an FK to bill, and both carry policies.
DROP TABLE IF EXISTS bill_document;
DROP TABLE IF EXISTS bill_message;
DELETE FROM _prisma_migrations
 WHERE migration_name IN ('20261011120300_bill_document', '20261011120100_bill_message');
```

These statements have been run, on a throwaway database rather than
staging (2026-10-14): both drops succeed without `CASCADE`, so nothing
else holds a foreign key to either table, the `DELETE` removes exactly two
rows, and `migrate deploy` afterwards re-applies both migrations with
their policies intact — the rollback is recoverable forward. Untested with
real rows in either table.

Then the dependency, if the API is also being reverted to a release that
predates it: dropping `pnpm.patchedDependencies` and the `patches/`
entry is safe **only** once nothing imports `@react-pdf/renderer`.
Removing the patch while the import remains reproduces the startup
crash in §1.

**What rollback does not undo:** PDFs already written to a tenant's
object store. They are not deleted — by design, since a bill that was
produced is a record of what the customer was shown. Object keys are
deterministic (`bills/{utility_id}/{bill_id}.pdf`), so a later
regeneration overwrites in place rather than accumulating copies; a
dropped `bill_document` table leaves those objects orphaned but inert,
and re-applying the migration does not rediscover them. Clearing them is
a bucket lifecycle action on the tenant's side, not ours.

Audit rows under `entity_type = 'BillDocument'` also survive a table
drop, and should: they record what was produced, not what currently
exists.
