# PBI-018: Garmin Cloudflare Egress Spike

**Status:** Closed

## Directive

Before implementing the full Garmin connector, run a small Cloudflare-hosted spike to determine whether Garmin Connect login/API access is feasible from Cloudflare egress using `python-garminconnect` or an equivalent minimal probe.

## Scope

- **Spec:** `specs/ingestion/spec.md`
- **Covers DoD items:** Cloudflare egress feasibility evidence for Garmin, including dependency/runtime fit, auth/MFA behavior, possible Garmin blocking, and a go/no-go recommendation for PBI-017.
- **Out of scope:**
  - Persisting Garmin data into brainfog.
  - Implementing the production Garmin connector.
  - Storing real Garmin credentials in committed files or long-lived test fixtures.
  - Adding a user-facing setup UI.
  - Importing historical activity data.

## Dependencies

- PBI-016 should be complete so run-history concepts exist, but this spike may remain isolated from production ingestion tables.
- PBI-018 is recommended if the spike needs D1-encrypted credentials. If faster and safer, the spike may use temporary Wrangler secrets or one-time manual secret injection, but it must not commit secrets.
- Adding Cloudflare Containers is a new Cloudflare product/binding. This PBI is the point where that decision is explicitly evaluated before production Garmin implementation.

## Context

### Why This Work

Garmin access is unofficial. `python-garminconnect` depends on private Garmin Connect endpoints, Garmin SSO behavior, token refresh, MFA handling, and `curl_cffi` for client/TLS behavior. It may fail from Cloudflare because of runtime limitations, native dependency issues, bot detection, IP reputation, TLS fingerprinting, rate limiting, or MFA/session behavior.

It is cheaper to learn that before building encrypted Garmin credential storage, a production runner, and multi-user scheduling around an access path Garmin blocks.

### Spike Shape

Preferred probe:

1. Create a minimal Cloudflare Container image with Python and `python-garminconnect`.
2. Trigger it from a Worker endpoint or Workflow using temporary test credentials supplied via secrets or secure manual input.
3. Attempt login/token load and a tiny bounded read, such as profile/current user metadata plus one recent activity list call or one daily summary call.
4. Return only sanitized diagnostics: success/failure category, HTTP status families, dependency/runtime errors, MFA-required state, and whether Garmin appears to block Cloudflare egress.
5. Delete any temporary token/session state after the spike unless it is encrypted per PBI-018.

Fallback probe:

- If Containers are unavailable or too heavy for the spike, document why Python Worker is unsuitable (`curl_cffi`/native dependency) and run a minimal JS/Python `fetch` probe only to Garmin public/login endpoints to test obvious Cloudflare egress blocking. This is weaker evidence and should be marked as such.

### Expected Output

Add a short note under `docs/notes/` or append a `## Spike Evidence` section to this PBI documenting:

- Runtime used: Container, Python Worker, or weaker fetch probe.
- Whether `python-garminconnect` could install/start.
- Whether Garmin login/token reuse worked, required MFA, or failed.
- Whether at least one activity or daily summary endpoint could be read.
- Whether Cloudflare egress appeared blocked or rate-limited.
- Recommendation: proceed with Cloudflare Container Garmin runner, change approach, or defer/drop Garmin.

## Intent Preservation

1. **No production ingestion.** The spike must not create Garmin time-series points unless explicitly turned into PBI-017 later.
2. **No secrets committed.** Garmin credentials, MFA codes, session tokens, and payloads stay out of git and logs.
3. **Bounded data.** Fetch the smallest possible Garmin data needed to prove feasibility.
4. **Cloudflare-only evidence.** The test must run from Cloudflare-hosted runtime, not a laptop, because the question is whether Cloudflare egress/runtime works.
5. **Multi-user implication.** The spike should document whether the proposed runner can be invoked once per connector/user with isolated credentials/session state.

## Verification

### Build and Type Checks

- Any committed spike code passes `pnpm check && pnpm typecheck && pnpm test`.
- `pnpm build` passes if Worker config or bindings change.

### Runtime Evidence

- A Cloudflare-hosted run is triggered and documented, or the exact blocker preventing a Cloudflare-hosted run is documented.
- The spike result clearly categorizes Garmin access as `proceed`, `proceed_with_risks`, `blocked`, or `inconclusive`.
- No real credentials or personal Garmin payloads are committed.

## Refinement Protocol

- If Garmin blocks Cloudflare egress, stop and report rather than building PBI-017 as planned.
- If `python-garminconnect` cannot run in a Container, document the failure and do not attempt to port Garmin private auth to TypeScript in this spike.
- If MFA requires an interactive setup flow, document the minimum setup-state model needed for PBI-017.
- If using Containers requires account/plan changes or costs, report before proceeding beyond the spike.

## Close-Out Checklist

- [x] Cloudflare-hosted Garmin feasibility probe implemented or blocker documented.
- [x] Sanitized spike evidence recorded.
- [x] Recommendation for PBI-017 recorded.
- [x] No Garmin secrets or personal payloads committed.
- [x] `specs/ingestion/spec.md` DoD item for the spike updated with completion evidence.
- [x] Required gates pass for any committed code/config.

## Closed Outcome

- Result: `proceed_with_risks`.
- Evidence: `docs/notes/garmin-cloudflare-egress-spike.md` records the sanitized hosted result.
- Handoff: PBI-019 must either promote/refactor the spike container and admin route into the production Garmin runner, or replace them and remove the spike-only route before closing the Garmin MVP.
