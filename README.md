# Rolzo Watcher — behavior reference

What this actually does when running, end to end: the deployment model,
every fallback/retry path, and exactly what auth relies on. `ARCHITECTURE.md`
covers *how it was reverse-engineered*; this covers *how it behaves*.
`TODO.md` covers what's deliberately not built yet.

## What it does, in one loop

```
poll GET .../new-booking every POLL_INTERVAL_MS (default 10s)
  -> new booking appears in the list?
       item.isForPartner  -> POST dispatch/{bookingId}/{ourSupplierId}   (empty body)
       item.isForDriver   -> POST partners/{bookingId}                  (accept payload)
       neither             -> Discord "🙋 MANUAL ACTION NEEDED", no auto-accept
  -> whichever endpoint answered, NEVER trust its response as proof of a win —
     re-read GET external/partnerBooking/{bookingId}/{token} and check
     dispatch.supplierId === our own supplier id. That's the only thing that
     actually confirms we got it (see ARCHITECTURE.md for why: the accept
     endpoint returned "success" once on a booking we did not get).
  -> report the verified outcome to Discord + logs, either way
```

No browser anywhere. Every request is a direct HTTPS call with the same
`X-Auth-Token` / `X-User-Id` headers Rolzo's own frontend sends.

## Auth — what it is, what it isn't

- **Two static headers**, not cookies. Confirmed by reading Rolzo's own
  frontend code and by grepping this script: the word "cookie" does not
  appear in it. Nothing is stored/replayed from `Set-Cookie`.
- **Lifetime is unknown and unverified.** One observed data point: a token
  lasted ~7.5 hours before failing. Could be TTL, could be something else
  (see the open question in `TODO.md`). Do not treat 7.5h as a real number.
- **No refresh-token endpoint exists.** The only way to get a new token is a
  real login (which this bot does not do — see "password auto-login,
  deliberately not built" in `TODO.md`) or copying a fresh one out of an
  already-logged-in browser, which is what the bookmarklet automates.
- **Getting a fresh token in:** open Rolzo in a logged-in browser tab, click
  the "Refresh Rolzo Token" bookmarklet (`refresh-bookmarklet.txt`). It reads
  `localStorage["RolzoCurrentUser"]` from that page and POSTs `authToken` +
  `userId` to this service's `/update-creds`, authenticated by
  `REFRESH_SECRET`. Updates the running process immediately — no restart.

## Failure handling and retries

Every poll failure, whether it's a bad HTTP response (expired token) or a
network-level error (timeout, DNS, connection reset), goes through the same
escalation — network failures used to be invisible until this was fixed:

| consecutive failures | what happens |
|---|---|
| 1–2 | silent, just retries next interval (transient blips happen) |
| 3 | one Discord warning, still retrying |
| 5 | **pauses** polling entirely, Discord alert explaining why |

"Paused" ≠ crashed. The process stays alive — the HTTP server and Discord
listener keep running, it just stops sending requests to Rolzo, specifically
so a dead token doesn't turn into a burst of failed auth requests (the
pattern that risks an IP getting rate-limited/flagged).

**Resuming** happens three ways:
1. Click the refresh bookmarklet — auto-resumes *only* if the pause reason
   was `'auth'` (won't override a deliberate `!stop`).
2. Send `!start` in Discord — resumes regardless of pause reason.
3. Restart the process manually.

**Crash resilience**, separate from the pause/resume above:
- `pollLoop()` errors are caught per-iteration and don't kill the loop.
- If something throws all the way out of that, `main()`'s outer wrapper
  logs it, alerts Discord, waits 5s, and restarts the loop — the process
  itself never exits.
- `uncaughtException` / `unhandledRejection` are caught at the process
  level (would otherwise crash Node entirely), logged, and alert Discord.
  The process keeps running, but this represents something genuinely
  unanticipated — worth actually reading the log when it fires.

**Single-instance lock:** the credential-refresh HTTP server's port doubles
as a mutex. A second copy trying to start hits `EADDRINUSE` and exits
immediately, before polling — prevents two instances double-polling and
racing each other to accept the same booking. Tested: a manually-launched
duplicate exited cleanly while the original kept running.

## Deployment behavior

**Local vs. hosted (e.g. Render) is auto-detected**, not configured:

- If `PORT` is set in the environment (Render sets this automatically), the
  server binds `0.0.0.0` on that port — internet-reachable.
- If `PORT` isn't set (local run), it binds `127.0.0.1` on `REFRESH_SERVER_PORT`
  (default 47823) — reachable only from this machine.
- **Startup refuses to run** if bound to `0.0.0.0` without `REFRESH_SECRET`
  set — that combination would let anyone who finds the URL POST arbitrary
  credentials to `/update-creds` and hijack which Rolzo account this acts
  as. Tested: confirmed it exits with a clear error in that state.

**`GET /health`** — deliberately unauthenticated (nothing sensitive to
protect, and it needs to be freely pingable). Returns
`{ok, state, dryRun, uptimeSeconds}`. Point an external uptime pinger
(cron-job.org, UptimeRobot, etc.) at this on a hosted free tier that spins
down on inactivity — **must be external**, since a pinger running inside
this same process would be asleep right along with it.

**Credential persistence across restarts** — the ephemeral-filesystem
problem: a hosted platform's local disk resets on every restart, so a
refreshed token written only to `rolzo.local.env` would be lost the next
time the container restarts for any reason (redeploy, crash, host
maintenance), reverting to the stale value in the platform's own env var
config. Two layers handle this:
1. Always: written to the local file (works until a restart).
2. If `RENDER_API_KEY` + `RENDER_SERVICE_ID` are set: also persisted to
   Render's actual env var via their API — confirmed this does not itself
   trigger a redeploy, so the next restart (whenever it happens) boots up
   already correct. If this save fails, you get a specific Discord alert
   saying so (`⚠️ Token refreshed, but NOT protected against a Render
   restart`) rather than silent false confidence.

## Discord integration

**Outbound alerts** (15 distinct call sites) cover: booking detected/won/
missed/unverified/manual-action-needed, auth pause/resume/warning, crash
restart, refresh-server bind errors, unauthorized refresh attempts,
Render-persistence failures, supplier-ID resolution failures, and uncaught
process-level errors. Deliberately log-only (no Discord alert): a duplicate
instance exiting cleanly (nothing went wrong), and Discord Gateway
connection errors (can't alert *via* Discord when Discord itself is what's
unreachable).

**Inbound commands** (needs "Message Content Intent" enabled in the Discord
Developer Portal — off by default, and without it every message arrives
with empty content):
- `!status` — running/paused state, live vs. dry-run, uptime, poll count,
  supplier ID resolved, last significant event, and the actual last ~8 lines
  of the real log file (not a synthesized summary).
- `!stop` — pauses polling (reason `'manual'`). Does not kill the process —
  it keeps listening so it can hear `!start` afterward.
- `!start` — resumes, whatever the pause reason was.
- `!skip` — stacking counter, not a toggle. Each `!skip` adds 1. While the
  counter is above 0, the *next* booking this process sees (any flow —
  partner, driver, or unknown) is not accepted at all — it's reported to
  Discord as skipped, with full booking details, and the counter drops by
  one. Hits 0 → the very next booking after that goes through completely
  normal auto-accept, no lingering effect.
- `!unskip` — the reverse, one at a time: decrements the counter by 1 (floor
  0). Says so if there was nothing queued to remove.

Both `!skip` and `!unskip` reply with the resulting count so it's never
ambiguous how many are queued, and the count also shows in `!status`.

Commands only act on messages in `DISCORD_CHANNEL_ID`, from non-bot authors.

## Logging

- **Terminal**: colored, one line per event, human-scannable.
- **`logs.txt`**: same events, plain text, human-readable, timestamped in
  `DISPLAY_TZ` (default `America/New_York`, DST-aware via `Intl`, not a
  hardcoded offset).
- **`rolzo-watcher.log`**: same events as structured JSON lines (UTC +
  local-time both included per line) — for parsing/tooling.
- Both **rotate at 5MB**, keeping one previous generation (`*.1`).
- **`raw-captures/`**: full untouched request/response JSON per booking
  event — the ground truth that caught the false-success bug in the first
  place. Not committed to git (`.gitignore`) — contains real customer PII
  (names, phone numbers, payment card last 4).

## Environment variables

| var | required? | purpose |
|---|---|---|
| `ROLZO_AUTH_TOKEN` | yes | session token (see Auth above) |
| `ROLZO_USER_ID` | yes | paired with the token |
| `ROLZO_PARTNER_TOKEN` | yes | the path segment from your New Bookings URL |
| `ROLZO_PARTNER_TYPE` | no (default `chauffeur`) | `chauffeur` \| `rental` \| `meetGreet` |
| `POLL_INTERVAL_MS` | no (default `10000`) | unverified against any real Rolzo rate limit |
| `DRY_RUN` | no (default off) | `1` = detect only, never actually accepts |
| `DISCORD_BOT_TOKEN` / `DISCORD_CHANNEL_ID` | no, but needed for all Discord features | |
| `REFRESH_SERVER_PORT` | no (default `47823`) | local-run port; ignored if `PORT` is set |
| `PORT` | set automatically by Render | switches bind to `0.0.0.0` |
| `REFRESH_SECRET` | **required if internet-facing** | auth for `/update-creds`; startup refuses to run without it when bound to `0.0.0.0` |
| `RENDER_API_KEY` / `RENDER_SERVICE_ID` | no, but closes the restart-persistence gap | see "Credential persistence" above |
| `DISPLAY_TZ` | no (default `America/New_York`) | any IANA zone name |

## Known gaps (honest, not hidden)

- Token TTL is one unverified data point, not a real number.
- No automated re-login of any kind — every credential refresh needs a
  human with a logged-in browser, by design (the alternative is storing a
  password, a materially bigger secret — see `TODO.md`).
- `RENDER_API_KEY`/`RENDER_SERVICE_ID` are optional — without them, a
  refreshed token doesn't survive a Render restart, and you'd need to
  refresh again after one happens.
- Bookings that are neither `isForPartner` nor `isForDriver` (shouldn't
  happen based on everything observed so far, but not proven impossible)
  get a manual-action alert, not an accept attempt.
