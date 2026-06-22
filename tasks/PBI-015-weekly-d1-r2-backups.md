# PBI-015: Weekly D1 SQL Backups To R2

## Directive

Add a weekly Cloudflare-native backup job that exports the hosted brainfog D1 database as SQL and stores the dump in a dedicated R2 bucket for retention beyond D1 Time Travel.

## Scope

- **Spec:** `specs/platform-setup/spec.md`
- **New DoD items:**
  - A Cloudflare Workflow runs on a weekly cron schedule and initiates a D1 SQL export through the Cloudflare D1 REST export API.
  - The Workflow polls the export job until Cloudflare returns a signed SQL dump URL, then streams the dump into R2.
  - Backups are stored in a dedicated R2 bucket binding, separate from the `DOCUMENTS` bucket used for canonical document content.
  - Backup object keys are deterministic and timestamped so weekly backup history is easy to browse, e.g. `d1/brainfog/YYYY/MM/DD/<filename-or-timestamp>.sql`.
  - The D1 export API token is read only from a Wrangler-managed secret; no real Cloudflare token, account id, or other secret is committed.
  - Required non-secret configuration is documented in `.dev.vars.example` or equivalent project docs.
  - Local tests cover the Workflow logic without calling the real Cloudflare API or writing to production R2.
  - Existing Worker routes, auth behavior, MCP behavior, and memory write provenance are unchanged.
- **Out of scope:**
  - Restoring from an R2 backup dump.
  - R2 lifecycle rules, bucket locks, retention policy automation, or offsite replication.
  - Backing up Vectorize; Vectorize remains derived/rebuildable from D1.
  - Backing up R2 document content; this PBI covers D1 structured data only.
  - Adding an admin UI or REST endpoint to trigger backups manually.

## Dependencies

- The existing hosted D1 database and Worker deployment in `apps/worker/wrangler.jsonc` must remain the single production target.
- A Cloudflare API token with D1 export permission must be configured as the production secret `D1_REST_API_TOKEN` before the scheduled job can run in production.
- If a dedicated R2 backup bucket does not already exist, it must be created during deployment/setup as `brainfog-d1-backups` or another explicitly configured bucket name.

## Context

### Why This Work

D1 Time Travel provides built-in point-in-time recovery, but its retention is bounded by plan limits and it does not produce long-lived archive files. Weekly SQL dumps in R2 provide a simple, Cloudflare-only, durable recovery artifact for brainfog's canonical structured data.

Cloudflare's documented best option is a scheduled Workflow that uses the D1 REST export API and writes the resulting SQL dump to R2. Workflows are preferred over a plain Cron Trigger because the export is asynchronous and benefits from durable step retries.

### Target Cloudflare Flow

1. A Workflow schedule, e.g. `0 2 * * SUN`, starts one backup run each week.
2. The Workflow calls `POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/d1/database/{DATABASE_ID}/export` with `{ "output_format": "polling" }`.
3. The Workflow records the returned `at_bookmark`.
4. The Workflow polls the same endpoint with `{ "current_bookmark": at_bookmark }` until the export is complete.
5. When the API returns a signed download URL and filename, the Workflow downloads the SQL dump and writes it to the backup R2 bucket.

### Operational Notes

- D1 exports may make the database unavailable for queries while an export is running, especially for larger databases. The weekly schedule should run during a quiet UTC window.
- D1 Time Travel remains enabled and complementary; it is not replaced by these R2 archives.
- The D1 export signed URL is temporary, so the Workflow must download and store the dump during the run.
- Production secrets must be set with Wrangler and must not be represented by real values in committed files.

## Intent Preservation

1. **Cloudflare-only.** The backup job uses Cloudflare Workflows, D1 REST API, and R2 only. No external scheduler, CI provider, database, or object storage is introduced.
2. **D1 remains canonical.** Backups are archive artifacts for recovery. Runtime reads and writes continue to use D1 as the source of truth.
3. **R2 document semantics remain separate.** The existing `DOCUMENTS` bucket remains canonical only for document content per ADR-008. D1 SQL dumps use a separate backup bucket binding and key prefix.
4. **No route/auth drift.** This PBI must not add unauthenticated app routes or change `/api/v1/*`, `/mcp`, OAuth, or static bearer-token behavior.
5. **No secret leakage.** API tokens and account-specific credentials are not committed. `.dev.vars.example` may contain names and placeholders only.
6. **No memory write side effects.** The backup job must not create or mutate memory records, provenance, Vectorize entries, users, tokens, or documents.

## Verification

### Build and Type Checks

- `pnpm check && pnpm typecheck && pnpm test` pass.
- `pnpm build` passes with the new Workflow and R2 backup binding declared.

### Unit / Worker Tests

- Workflow tests mock the D1 export API start response and verify that `at_bookmark` is used for polling.
- Workflow tests mock a completed export and verify the SQL dump body is written to the backup R2 bucket.
- Workflow tests cover at least one retry/error path, such as missing `at_bookmark`, missing signed URL, failed dump fetch, or failed API response.
- Existing auth, REST, MCP, memory, and page tests continue to pass.

### Deployment / Runtime Checks

- The dedicated R2 backup bucket exists before deployment or is created as part of the deployment process.
- The `D1_REST_API_TOKEN` production secret is present before the scheduled Workflow is expected to run.
- `pnpm run deploy` succeeds.
- If possible without waiting for the weekly schedule, trigger or invoke the backup path manually/test-scheduled and confirm a SQL object is written to the backup R2 bucket. If production manual triggering is not possible in this session, document the limitation and the exact follow-up command/check.

## Refinement Protocol

If the Cloudflare Workflows API, Wrangler config schema, or local test runtime differs from Cloudflare's published example:

1. Prefer the smallest implementation that keeps the backup job Cloudflare-only and uses the D1 REST export endpoint.
2. If Workflows cannot be used in this Worker without a new architecture decision, stop and ask before falling back to plain Cron Triggers or external CI.
3. If test support for Workflows is incomplete locally, unit-test the backup logic as a pure function with mocked `fetch` and mocked R2 bindings, then document any remaining runtime verification gap.
4. Do not change the `specs/platform-setup/spec.md` Contract section without explicit approval.

## Close-Out Checklist

- [x] Weekly Workflow backup implementation merged into the Worker package.
- [x] Dedicated R2 backup bucket binding configured.
- [x] Required vars/secrets documented without real values.
- [x] Deterministic gates pass: `pnpm check && pnpm typecheck && pnpm test`.
- [x] Build/deploy gate passes: `pnpm build` and `pnpm run deploy`.
- [x] Manual or local scheduled backup test evidence recorded, or limitation documented with follow-up steps.

## Completion Evidence

Implements weekly D1 SQL exports to R2 using Cloudflare Workflows, per Cloudflare's documented D1-to-R2 backup pattern.

- **`apps/worker/src/d1-backup-workflow.ts`** — new `D1BackupWorkflow` class plus testable `runD1Backup` helper. The helper validates `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID`, and `D1_REST_API_TOKEN`; starts a D1 export with `output_format: "polling"`; polls using `current_bookmark`; downloads the signed SQL dump; and writes it to `env.D1_BACKUPS` with `application/sql` metadata.
- **`apps/worker/src/index.ts`** — exports `D1BackupWorkflow` so Wrangler can bind the Workflow class.
- **`apps/worker/wrangler.jsonc`** — declares dedicated R2 bucket binding `D1_BACKUPS` (`brainfog-d1-backups`) and weekly Workflow binding `D1_BACKUP_WORKFLOW` (`brainfog-weekly-d1-backup`) with schedule `0 2 * * SUN`.
- **`apps/worker/src/env.ts`** and **`apps/worker/worker-configuration.d.ts`** — include the new Workflow, R2, and backup configuration bindings.
- **`.dev.vars.example`** and **`apps/worker/.dev.vars.example`** — document `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID`, and `D1_REST_API_TOKEN` placeholders. No real token values are committed; production `D1_REST_API_TOKEN` must be set as a Wrangler secret.
- **`apps/worker/test/d1-backup-workflow.test.ts`** — mocks the Cloudflare D1 export API, signed dump fetch, and R2 bucket writes. Coverage verifies export start, bookmark polling, SQL body storage, missing bookmark failure, and deterministic backup key generation.
- **Gate-unblocker fixes:** `apps/worker/src/ui/layout.tsx` received a Biome-only JSX formatting fix, and `apps/worker/test/ui-pages.test.ts` removed a stale `tokens.label` fixture field that no longer exists in schema types. These were required for repo-wide `pnpm check` and `pnpm typecheck` to pass and are not behavior changes for PBI-015.

**Verification:**

- `pnpm check && pnpm typecheck && pnpm test` passed on 2026-06-18. Vitest: 9 files, 203 tests passed.
- `pnpm build` passed on 2026-06-18. Wrangler dry-run reported `D1_BACKUP_WORKFLOW`, `D1_BACKUPS`, `DOCUMENTS`, `DB`, `VECTORIZE`, `AI`, `OAUTH_KV`, `MCP_OBJECT`, and `D1_DATABASE_ID` bindings.
- Critic review passed with no blocking findings. The only note was the two documented gate-unblocker fixes above.

**Deployment / Runtime Notes:**

- Created production R2 bucket `brainfog-d1-backups` on 2026-06-18 (`WEUR`, Standard storage class).
- `pnpm run deploy` passed on 2026-06-18. Final deployed Worker version `1b716428-4eaf-4697-8b93-5035d53bba22`; Cloudflare reported `workflow: brainfog-weekly-d1-backup` and URL `https://brainfog.francois-wmgc.workers.dev`.
- Production health check after deploy passed: `GET /api/v1/health` returned `{ "status": "ok" }`.
- Production secret inspection after deploy initially showed only `BRAINFOG_TOKEN_HASH_SECRET` configured. The user then configured `CLOUDFLARE_ACCOUNT_ID` and `D1_REST_API_TOKEN`; follow-up inspection confirmed all three secrets were present.
- `D1_DATABASE_ID` is deployed as a non-secret Wrangler environment variable.
- Manual production backup trigger passed on 2026-06-18: `pnpm exec wrangler workflows trigger brainfog-weekly-d1-backup '{"source":"manual-test"}'` queued instance `91ce5877-6064-43bc-99d4-cb3c93fda0fb`.
- `pnpm exec wrangler workflows instances describe brainfog-weekly-d1-backup 91ce5877-6064-43bc-99d4-cb3c93fda0fb` reported `Status: Completed`, `Success: Yes`, with successful steps `start D1 SQL export`, `poll D1 SQL export 1`, and `store D1 SQL export in R2`.
- The Workflow wrote R2 key `d1/brainfog/2026/06/18/4627ecde-2253-47a6-be90-bb310d937c25-00000185-00002e5a-0000508e-dfd0ca08f7eed8d7d12008aab2a27ce9.sql`.
- Remote R2 verification passed: `pnpm exec wrangler r2 object get "brainfog-d1-backups/d1/brainfog/2026/06/18/4627ecde-2253-47a6-be90-bb310d937c25-00000185-00002e5a-0000508e-dfd0ca08f7eed8d7d12008aab2a27ce9.sql" --remote --file "/var/folders/t7/n6qgvzcx4pv8ybk_kq6tprbm0000gn/T/opencode/brainfog-d1-backup-test.sql"` completed successfully; downloaded file size was 112,843 bytes.

## Ship-PBI Log

- **Iteration 1 (implementor):** Added `D1BackupWorkflow`, weekly Workflow schedule, `D1_BACKUPS` R2 binding, D1 REST export start/poll logic, deterministic R2 keys, and mocked unit tests for export/poll/write/error behavior.
- **Deterministic gate fixes:** `pnpm check` and `pnpm typecheck` initially exposed two unrelated existing blockers: a Biome format issue in `apps/worker/src/ui/layout.tsx` and a stale `tokens.label` fixture in `apps/worker/test/ui-pages.test.ts`. Applied minimal fixes so the required repo-wide gates could run green.
- **Deterministic gates:** `pnpm check && pnpm typecheck && pnpm test` passed with 203 tests. `pnpm build` passed and dry-run showed `D1_BACKUP_WORKFLOW` plus `D1_BACKUPS` bindings.
- **Critic review:** Passed with no blocking findings. Critic noted the two deterministic gate fixes above as non-blocking scope notes.
