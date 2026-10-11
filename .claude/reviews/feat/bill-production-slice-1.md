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
- Boot command (including prerequisites): `<exact command>`
- User action performed: `<exact steps>`
- Expected observable result: `<description>`
- Actual observed result: `<paste output / screenshot link>`
- [ ] Test passed

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
- Runbook path: <path to committed runbook.md>
- Dry-run evidence (staging): <log excerpt or link>
- Rollback command: `<exact command>`
- [ ] Rollback tested in staging — verification output: <paste>

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
