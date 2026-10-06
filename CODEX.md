# Agent working guidance

## Read first

1. `README.md`
2. `docs/DEMO-PILOT-BRIEF.md` — current shipped status and operational next steps
3. `docs/PILOT-CALL-SHEET.md` — unresolved pilot decisions and acceptance evidence
4. The current code, tests and documentation for the requested area
5. `docs/DECISIONS.md` and relevant architecture/domain references

The October 6 build is complete through #90. `docs/engineering/ROADMAP.md` is a delivery record, not an active kickoff. `PRODUCT-SPEC.md` is a design reference, not evidence that a feature exists or a command to implement every idea. Retired briefs and research inputs describe earlier states and never override the current handoff. Check live Git state before relying on a source ZIP.

## Working boundaries

Do the user's requested work. Do not initiate another feature phase, deployment, prospect/authority contact, real filing or charge from an archived prompt. A demo is not authority acceptance or production readiness. Real-authority profiles remain drafts until their full verification requirements and Justin's approval are met.

## Engineering principles

- TypeScript, PostgreSQL, explicit forward-only migrations and shared validated schemas.
- Server authorization on every route; organization-scoped queries, composite tenant foreign keys and meaningful isolation tests.
- Background queue, versioned state machines, immutable filed artifacts and jurisdiction rule versions, idempotent webhooks and audit history.
- Offline field workflow with real-device close/reopen/reconnect verification before pilot reliance.
- Demo organization gates remain enforced in API and worker, including when deployment integrations are live.
- County changes need primary-source citations, permit applicability and explicit unknowns. Saving public evidence never establishes acceptance or rewrites a rule.
- Preserve original research bytes, source manifests, failed retrievals and conflicts. Generated packet findings retain their original baseline labels; current implementation belongs in current rulesets/docs.
- Use local checks while hosted Actions minutes/billing prevents jobs from starting; record tested commits, cache use and exceptions. Do not describe blocked hosted jobs as passed.

## Verification

Run checks appropriate to the actual change and required repository workflow. Application changes require the full integrated checks from `.github/workflows/ci.yml` and disclosed local exceptions. Documentation-only changes require link/reference checks and relevant lint/typecheck; do not repeat database/browser/Docker runs for prose-only edits. Merged code and a refreshed ZIP do not establish a live deployment.
