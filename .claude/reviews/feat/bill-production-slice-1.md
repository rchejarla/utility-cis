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
  portal screen can call it — descoped), and anything against a real
  apptor-connect, which was faked throughout.

## Cross-layer contract check (Tier 2+)
- [ ] Dispatched cross-layer-auditor
- Grep 1 — Orphan fields (UI writes → backend reads):
- Grep 2 — Orphan endpoints (backend declares → frontend calls):
- Grep 3 — Unhandled events (emitted → handled):
- Grep 4 — Write-only DB columns (written → read):
- Grep 5 — Unread config keys (declared → read):
- Orphans requiring fix: <list, or "none">
- Intentional orphans with justification: <list, or "none">

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
  - <step name> — <one sentence why>

## Final verdict
- [ ] All required gates passed for declared tier
- [ ] Checklist committed
- [ ] Ready to ship

Signed: <Claude-session-or-human-reviewer>
Date: YYYY-MM-DD
