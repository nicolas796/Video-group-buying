# Load Test Suite

This suite validates the group buying service before launch. It provides:

1. **Mock Twilio transport** with rate limiting, random 5xx failures, and message logging
2. **Artillery scenarios** for baseline, stress, and spike traffic
3. **Data integrity verifier** to catch duplicate joins or counter drift
4. **Single command runner** that evaluates performance against launch criteria

## Prerequisites

- Node.js 18+
- Dependencies installed (`npm install` from repository root)

## Key Files

| Component | Purpose |
| --- | --- |
| `load-tests/mocks/twilio-mock.js` | Drop-in Twilio SDK replacement. Enable with `USE_MOCK_TWILIO=true`. Supports env tuning via `TWILIO_MOCK_MAX_RPS`, `TWILIO_MOCK_FAILURE_RATE`, `TWILIO_MOCK_LATENCY_MS`, `TWILIO_MOCK_LATENCY_JITTER_MS`, and `TWILIO_MOCK_LOG_PATH`. |
| `load-tests/artillery/*.yml` | Artillery definitions for `baseline`, `stress`, and `spike` phases targeting `/api/campaigns/:id/join` and public read endpoints. |
| `load-tests/artillery/hooks.js` | Generates auth headers and randomized join payloads. |
| `load-tests/verify/check-counters.js` | Ensures participant counts and referral relations are consistent post-run. |
| `load-tests/run-all.js` | Orchestrates every phase, evaluates thresholds, and writes `load-tests/results/report.json`. |

## Running the suite

```bash
npm run load-test
```

This command executes:

1. `baseline` — ramp to & sustain ~150 concurrent users for 5 minutes (target p95 < 500 ms)
2. `stress` — ramp from 10 to 150 req/s to verify <1% error rate at ~3× traffic
3. `spike` — 0→200 req/s in 10s, hold 2 min, then cool down (ensures graceful failure)
4. Data integrity verification for the target campaign

All results are stored under `load-tests/results/` including the aggregated `report.json`.

### Environment variables

| Variable | Description | Default |
| --- | --- | --- |
| `LOAD_TEST_BASE_URL` | Base URL for the API under test | `http://localhost:8080` |
| `LOAD_TEST_CAMPAIGN_ID` | Campaign ID to exercise | `005EZsfHkpI` |
| `LOAD_TEST_REFERRER` | Optional referral code used in payloads | *(blank)* |
| `LOAD_TEST_AUTH_HEADER` | Authorization header value used to satisfy CSRF bypass | `Bearer load-test-suite` |
| `LOAD_TEST_PHONE_PREFIX` | Phone prefix for synthetic users | `+1555` |
| `USE_MOCK_TWILIO` | Forces Twilio mock transport | `true` via runner |

### Rate limiting configuration

The API enforces two tiers of rate limiting:

1. **Read tier** — Applies to GET endpoints (campaign listings, stats, etc.).
2. **Write tier** — Applies to POST/PUT/DELETE endpoints (joins, brand updates, admin actions).
3. **Login tier** — Applies specifically to `/login` attempts per IP.

All tiers share a sliding-window implementation whose limits are controlled by environment variables so load tests can simulate realistic production values.

| Variable | Purpose | Default (Render) | Notes |
| --- | --- | --- | --- |
| `RATE_LIMIT_GET_MAX` | Max GET requests per IP within `RATE_LIMIT_WINDOW` | `100` | Typical baseline for public campaign browsing. Increase when fronting with CDN-level caching. |
| `RATE_LIMIT_WRITE_MAX` | Max write requests per IP within `RATE_LIMIT_WINDOW` | `50` | Launch default raised from 30 to accommodate promotional spikes. Lower for staging to catch abusive tests sooner. |
| `RATE_LIMIT_WINDOW` | Window size in milliseconds shared by GET/WRITE tiers | `60000` | Keep ≥30s to avoid oscillation under bursty loads. |
| `LOGIN_RATE_LIMIT_MAX` | Login attempts per IP allowed within `LOGIN_RATE_LIMIT_WINDOW` | `5` | Conservative to slow credential stuffing. Increase only if you rely on upstream CAPTCHA/2FA. |
| `LOGIN_RATE_LIMIT_WINDOW` | Window size for login throttling (ms) | `900000` (15 min) | Align with your lockout/alert policies. |

#### Adjusting limits for scenarios

- **Local development:** Keep GET at 100 / WRITE at 30 to mirror production but shorten `RATE_LIMIT_WINDOW` to `30000` ms if you need faster resets.
- **Stress testing:** Bump `RATE_LIMIT_GET_MAX` to 250 and `RATE_LIMIT_WRITE_MAX` to 100 so the limiter does not mask infrastructure bottlenecks during peak simulations.
- **Security hardening drills:** Drop `LOGIN_RATE_LIMIT_MAX` to 3 and shorten `LOGIN_RATE_LIMIT_WINDOW` to `300000` ms (5 min) to validate monitoring/alerting behavior.

Export the desired values before starting the server, e.g.:

```bash
RATE_LIMIT_GET_MAX=250 RATE_LIMIT_WRITE_MAX=100 npm start
```

Artillery inherits the limits because the server process reads them on boot. Document the chosen values in your run report so reviewers can reproduce the behavior.

### Adjusting thresholds

Thresholds are defined inside `load-tests/run-all.js` per scenario. Update `thresholds` for each entry if your SLA changes (e.g., tighten p95 or error rate).

### Interpreting results

- **PASS** — scenario metrics met thresholds
- **FAIL** — at least one metric exceeded allowed limits
- **Data integrity FAIL** — duplicate joins, missing referral parents, or counter anomalies were detected in `data/participants.json`

Review `load-tests/results/report.json` for the detailed breakdown, per-scenario metrics, and the READY/NOT READY conclusion.

### Manual utilities

Run a single scenario:

```bash
npx artillery run -t http://localhost:8080 load-tests/artillery/baseline.yml
```

Verify counters independently:

```bash
node load-tests/verify/check-counters.js --campaign 005EZsfHkpI
```

Inspect Twilio mock log:

```bash
cat load-tests/mocks/twilio-messages.log
```

## Launch Readiness Criteria

The generated report flags the release as **READY** only when:

1. Baseline p95 latency < 500 ms at 150 concurrent users
2. Stress error rate < 1% at ~3× expected load
3. Spike test completes without excessive p99 latency (>1200 ms) or high error rate (>2%)
4. Data integrity check reports no duplicates, negative counters, or broken referral graphs

Use the summary plus individual logs to decide whether additional hardening is required before opening the floodgates.
