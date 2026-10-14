# Review Checklist — feat/bill-production-slice-1

**Tier:** 3
**Tier rationale:** Two Prisma migrations fire the Tier 3 rule, but the real reason is three deploy-time prerequisites that fail silently or take the whole API down: the @react-pdf/hyphenate patch that lets the API boot at all, two apptor-connect env vars that default to a localhost no-op, and per-tenant issuer/storage settings without which every bill 422s.
**Blast radius:** 66 files changed (+8,480/-549); 3 packages touched (api 25, web 20, shared 8) plus root scripts/seed; user-facing: yes — the Bills screen, an account's AR tab, and two new Settings pages.
**Started:** 2026-10-11

## L1 code review (all tiers)
- [ ] Dispatched l1-reviewer
- Findings:
  - Critical: <file:line — problem, or "none">
  - Important: <file:line — problem, or "none">
  - Minor: <file:line — problem, or "none">
- Resolution: <fixed / deferred with reason per finding>

## Smoke test (all tiers) — EVIDENCE REQUIRED
- Boot command (including prerequisites):
  ```
  start_db.bat                                  # postgres + redis
  migrate_db.bat                                # applies both new migrations
  node scripts/fake-files-plane.mjs             # stands in for apptor-connect; APPTOR_CONNECT_URL defaults to :8080
  start_dev.bat                                 # api 3001, web 3000
  PATCH /api/v1/tenant-config                   # issuer.* + billDocuments.storageIntegration
  ```
- User action performed: on `/bills` in Chrome (driven over CDP, since the
  browser extension would not connect — real browser, real layout, real
  events): clicked **View bill** on a posted bill; clicked **More** on the
  lowest row and chose **Waive**; separately exercised every `state=`
  filter value and the widened search against the live API.
- Expected observable result: a real PDF of the bill, byte-identical to
  what was stored; the action menu opening on-screen next to its row and
  its items reaching their dialogs; filters and search returning the right
  bills.
- Actual observed result:
  - **PDF generated and stored.** `POST .../document` → 200,
    `byteSize: 3717`, `sha256: 8e983ab3…027`, `objectKey:
    bills/00000000-0000-4000-8000-000000000001/35a0a33f….pdf`. `GET` returned
    `Content-Type: application/pdf`, `Content-Disposition: attachment;
    filename="bill-BILL-202610-0001000-00.pdf"`, and `sha256sum` of the
    downloaded bytes matched the stored hash exactly. Object present on
    disk at the expected key.
  - **Content correct, not just well-formed.** Text extracted from the
    content stream: issuer block, `BILLED TO Jane Smith, 742 Evergreen
    Terrace`, two service groups with real rated lines (Water Service
    Charge $16.10, Water Usage – Single Family $29.90; Sewer Service
    Charge $22.66, Sewer Usage – Residential **(WQA)** $42.09), subtotals
    $46.00 and $64.75, Total due $110.75, remittance stub. Arithmetic
    ties to the stored total — Review Focus 1 holds on genuinely rated
    Bozeman data. `/CreationDate (D:20000101000000Z)` confirms the
    stabilizer pins timestamps.
  - **Refusal paths, on real data.** No billing address → 422
    `RECIPIENT_INCOMPLETE ["billingAddress"]`; unposted bill → 409
    `NOT_POSTED`; no storage integration → 422
    `STORAGE_NOT_CONFIGURED`; bogus `?state=` → 400.
  - **Generate-on-404.** With the document cleared: `GET` 404 → `POST`
    200 → `GET` 200, 3530 bytes, complete bill for Robert Johnson.
  - **Action menu.** Real mouse events on the lowest row's More: one menu,
    `top: 601` against a trigger bottom of 597, right edge 1844 against a
    trigger right edge of 1843.72, fully within the viewport; choosing
    Waive closed the menu and opened "Waive part of a charge". No console
    exceptions.
  - **Status filter.** unposted 1, outstanding 5, overdue 0 (nothing past
    due), partPaid 1, paid 0, reversed 0, unfiltered 6. The partPaid hit
    verified in SQL as a genuine 55.38 application against a 110.75
    charge, not a false positive.
  - **Search.** `0001002` → 1; `Jane Smith` → 2 (both hers, either word
    order, any case); `Acme` → 3; `Jane Nobody` → 0.
- [x] Test passed

  Not covered by this smoke test, and known: the portal download (no
  portal screen can call it — descoped). The apptor-connect gap that was
  recorded here has since been closed — see below.

### Live apptor-connect verification (2026-10-13)

Everything above went through `scripts/fake-files-plane.mjs`. Re-run
against a real `apptor-connect-service-1.0.0` on `:8080`, tenant `acme`,
integration `dev-files` (S3, bucket `dev-files`, root prefix `inbound/`,
backed by the `apptor-integrations-minio` container), with a freshly
minted API key. A second API instance on port 3101 carried the real
`APPTOR_CONNECT_*` values so the running dev server was left alone.

- **Contract verified against the live spec and source, not our reading
  of it.** Request fields `i`, `cn`, `key`, `op`, `ttlSeconds`,
  `maxBytes` match `FileLinkDtos.Request` exactly, abbreviations
  included; every response field `files-client` reads (`url`, `method`,
  `expiresAt`, `maxBytes`) exists on `FileLinkDtos.Response`. A real
  mint returned `via: "service"` and a link at `/files/v1/d`, matching
  what the client's own comment claims.
- **Auth is right, and the spec is misleading about it.**
  `/files/v1/links` declares `bearerAuth` (JWT) and only 3 of 80
  operations declare `apiKey`, which reads as though `X-Api-Key` cannot
  work there. It does: `FileLinkController` is
  `@Secured(IS_AUTHENTICATED)` and `ApiKeyTokenReader` registers
  `X-Api-Key` globally, with Micronaut offering every reader's token to
  every validator. Confirmed by a successful live mint. Worth knowing
  before someone "fixes" the client to send a bearer token.
- **End to end on real bytes.** `POST .../document?force=true` → 200,
  `byteSize: 3719`, `sha256: 2386d3d4…f30d`. `GET` → 200,
  `application/pdf`, `attachment; filename="bill-BILL-202610-0001000-00.pdf"`,
  3719 bytes downloaded, sha256 of the bytes equal to the stored hash.
  The object was independently fetched straight from `dev-files` through
  a separately minted GET link: same 3719 bytes, same hash.
- **One real bug, found only because the store is real.** See below.
- **Refusals on the real service.** Unposted bill → 409 `NOT_POSTED`. An
  integration the service does not hold → real 404, surfaced as 502
  `STORAGE_UNAVAILABLE` naming the integration and carrying no link.
- **Tenant scoping, concretely.** apptor-connect scopes files by the
  `tenant_id` carried on the API key; all keys on that instance belong to
  tenant `acme`. We send only an integration name and scope by
  `utility_id`. So with one deployment-level key, every utility's bills
  land in one apptor-connect tenant's store. That is the runbook's open
  provisioning question, now with a measured shape rather than a worry.

**Bug found and fixed: a forced regeneration left the row pointing at the
old store.** `storage` is resolved from the tenant's current settings and
that is where `putObject` writes, but on a forced regeneration the claim
is the pre-existing row, and the update wrote `byteSize`, `sha256`,
`generatedAt`, `templateKey` and `isPaperless` while leaving
`storageIntegration`, `storageConnection` and `objectKey` untouched. A
tenant who changed their storage integration and regenerated therefore
got bytes written to the new store, a row naming the old one, a
permanent 502 on every download, and the new bytes orphaned — with the
row's own `sha256` describing bytes it could not locate.

Observed, not reasoned about: after pointing the dev tenant at
`dev-files` and forcing a regeneration, `GET` answered 502
`STORAGE_UNAVAILABLE (integration "cis-bills")` while the row read
`storage_integration = cis-bills`, `byte_size = 3719` and the new hash,
and the object sat in `dev-files` under
`bills/00000000-0000-4000-8000-000000000001/35a0a33f….pdf`. The local
fake could never show this: it accepted every integration name, so both
the stale and the current name "worked".

Fixed by writing the resolved storage coordinates in the regeneration
update. Re-verified: forced regeneration → row moves to `dev-files`, and
`GET` → 200 with the hash matching. A stale row now repairs itself on the
next forced regeneration. Covered by a new integration test, "moves the
stored pointer when the tenant's storage integration changes".

## Cross-layer contract check (Tier 2+)
- [x] Dispatched cross-layer-auditor
- Grep 1 — Orphan fields (UI writes → backend reads): `settings.issuer` all 10
  fields round-trip (web → PATCH /tenant-config → bill-presentation.service);
  `settings.billDocuments` both fields round-trip; all 7 `BillMessage` fields
  have readers. `REQUIRED_ISSUER_FIELDS` is imported by both sides, so the
  form's required markers and the 422's `missing` list cannot drift. **One
  asymmetry:** the `POST /bills/:id/document` response body is entirely
  unconsumed by either caller.
- Grep 2 — Orphan endpoints (backend declares → frontend calls): 7 new routes,
  6 with callers. The 7th is `GET /portal/api/bills/:id/document` — no caller,
  matching the recorded descope. No orphan frontend call: every new fetch
  resolves to a route. The `state` enum is symmetric across all three layers,
  all 6 values handled in an exhaustive switch.
- Grep 3 — Unhandled events (emitted → handled): 5 new audit event types, all
  consumed as `audit_log` rows via `audit-wrap`. No dispatcher/listener by
  design — the EventEmitter pipeline was deleted. `bill_message.updated` has no
  explicit branch in `mapEventTypeToAction` and lands on the `UPDATE` default,
  which is the right answer.
- Grep 4 — Write-only DB columns (written → read): `bill_message` fully
  symmetric. On `bill_document`, three columns have no production reader —
  `template_key`, `generated_at`, `is_paperless` — plus `@@index([utilityId,
  generatedAt])` backs no query in this slice.
- Grep 5 — Unread config keys (declared → read): all 4 are read
  (`APPTOR_CONNECT_URL`, `APPTOR_CONNECT_API_KEY` in files-client;
  `BILL_DOCUMENT_LINK_TTL_SECONDS` in files-client;
  `BILL_DOCUMENT_MAX_BYTES` in bill-document.service). None appear in
  `.env.example`.
- Orphans requiring fix:
  1. `POST /api/v1/bills/:id/document` returns the full `BillDocumentRow` —
     `storageIntegration`, `storageConnection`, `objectKey` reach the browser
     while no caller reads any field. Contradicts files-client's stated
     principle that storage topology is not the client's knowledge.
  2. `bill_document.is_paperless` is set on the claim but not in the
     regeneration update, so `?force=true` keeps the first generation's value
     while the spec calls it a copy "at generation time". `generated_at` moves;
     this does not.
  3. The 5 new event types are inline literals, bypassing the `EVENT_TYPES`
     registry — whose own comment now falsely claims every service passes one
     of its constants.
  4. The 4 new config keys are absent from `.env.example`; both
     apptor-connect keys default to a silent no-op.
  5. (Found alongside) `STATE_OPTIONS` in `app/bills/page.tsx` is a
     hand-written literal, in sync with `billStates` only by luck.
- Resolution — all 5 fixed, `pnpm typecheck` clean:
  1. `producedDocument()` in `routes/bill-documents.ts` narrows the POST
     response to `billId`, `documentType`, `byteSize`, `sha256`,
     `generatedAt`. Storage topology no longer reaches the browser;
     `sha256`/`byteSize` stay because they describe the bytes the caller
     just caused to exist.
  2. `isPaperless` is now set in the regeneration update as well as the
     claim (`bill-document.service.ts`), so it moves with `generatedAt`.
  3. The 5 event types are `EVENT_TYPES` constants, referenced from both
     services. The registry's comment no longer claims an enforcement
     that `writeAuditRow`'s bare `string` parameter does not provide.
  4. All 4 keys added to `.env.example`, with the silent-no-op defaults
     called out in a comment.
  5. `STATE_LABELS: Record<BillState, string>` replaces the literal —
     a state added to or removed from the enum now fails to compile in
     the page. Display order stays hand-written, since the enum orders
     by meaning and the menu puts overdue next to outstanding.
- Intentional orphans with justification:
  1. `GET /portal/api/bills/:id/document` — no caller; portal UI descoped by
     decision. Endpoint and its tenant scoping are tested.
  2. `bill_document.template_key` — provenance: which layout produced a stored
     copy. Asserted in an integration test; no production reader by design.
  3. `bill_document.generated_at` — exists so a forced replacement is
     detectable after the fact. Its index is speculative and worth dropping if
     nothing queries it by the next slice.
  4. `bill_document.is_paperless` — placeholder for the unbuilt delivery slice.
     Weakest of the four: no stated reader even in the future design.
  5. `bill_message.created_at` / `updated_at` — standard audit timestamps.
  6. `BillPresentation.messages[].label` — carried but never printed; the
     settings page tells the operator it is staff-facing only.
  7. `BillDocument` / `BillMessage` missing from the audit-log entity filter —
     pre-existing gap shared with `Customer`, `Contact`, `Ledger*`. Consistent
     with what is there, not a regression from this branch.

## Adversarial review (Tier 2+)
- [ ] Dispatched adversarial-reviewer
- Blocking findings: <category + file:line + disposition, or "none">
- Non-blocking findings: <category + file:line + disposition, or "none">
- Reviewer's meta-notes: <which hostile question surfaced the most issues>

## Runbook + rollback (Tier 3)
- Runbook path: `docs/runbooks/bill-production-slice-1.md`
- Dry-run evidence (staging): **NOT DONE — no staging environment was
  available to this session.** What was exercised instead is the full
  deploy sequence against the dev database: `migrate_db.bat` applied both
  migrations from a clean state, both RLS policies attached, and the
  feature worked end to end afterwards (see the smoke test). That is not
  a staging dry run and should not be recorded as one. The three
  prerequisites in the runbook — the dependency patch, the two
  apptor-connect env vars, the per-tenant settings — have not been
  verified in any environment that resembles production.
- Rollback command: application rollback needs nothing; the two tables are
  additive and no earlier code reads them. To remove the schema as well:
  ```sql
  DROP TABLE IF EXISTS bill_document;
  DROP TABLE IF EXISTS bill_message;
  DELETE FROM _prisma_migrations
   WHERE migration_name IN ('20261011120300_bill_document', '20261011120100_bill_message');
  ```
- [ ] Rollback tested in staging — verification output: **not tested.**
  The drop statements above are untried. Note also what rollback cannot
  undo: PDFs already written to a tenant's object store survive, by
  design, and dropping `bill_document` orphans them.

## Escape hatches used
- [ ] None (default)
- Skipped steps with written justification:
  - **No staging dry-run, and the rollback SQL is untried** — no staging
    environment was available; see the Runbook section, which records what
    was done against the dev database instead and does not call it a dry run.
  - **Still unexercised against real apptor-connect, narrowly:** the
    `maxBytes` ceiling (no bill is anywhere near 10 MiB, so the enforced
    limit has never actually been hit), link expiry (`ttlSeconds` elapsing
    mid-transfer), and any store other than S3/minio. The protocol itself,
    auth, both transfer directions and the error mapping are now verified
    live — see the Live apptor-connect verification above.
  - **One deployment-level API key means one apptor-connect tenant** for
    every utility. Recorded as a finding above and as the runbook's open
    provisioning question; not a decision this branch can make.

## Final verdict
- [ ] All required gates passed for declared tier
- [ ] Checklist committed
- [ ] Ready to ship

Signed: <Claude-session-or-human-reviewer>
Date: YYYY-MM-DD
