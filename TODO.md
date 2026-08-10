# Open items / deferred decisions

Not implemented yet, deliberately — priority right now is proving the core
loop (detect → accept → actually win a real booking) works at all before
investing more in credential-refresh automation around it.

## Credential auto-refresh — decision made, not built

Discussed three options for handling token expiry without the manual
bookmarklet click:

1. **Auto-extract only, no password** — Playwright headless re-reads the
   token from an already-logged-in persistent browser profile on a timer
   (e.g. every 20-30 min), same thing the bookmarklet does, just automatic.
   No new secret stored. Still needs one manual login whenever the
   underlying browser session itself actually dies.
2. **Full password-based auto-login** ← *this is what was chosen* — store
   Rolzo email+password so the script (via Playwright or a direct API
   call) can log in from scratch whenever needed, zero human ever.
   - Real tradeoff, not implemented lightly: a stored password is full
     account access (billing, company settings, users) if this machine is
     ever compromised, vs. the current session token which is scoped and
     already self-expiring.
   - Also genuinely unverified: the driver portal's own login screen only
     collects an email (looks like a passwordless magic-link flow), not
     a password field. Whether email+password login (`POST login`,
     confirmed to exist in Rolzo's code for other account types) actually
     works for this account is unknown until tested.
   - Using Playwright/Selenium to do this instead of a raw API POST does
     **not** reduce the risk — it's the same password, same storage
     requirement, just typed into a simulated browser form instead of
     sent directly. Worth remembering if this gets revisited.
3. **Manual (bookmarklet)** — current state, working. One click whenever
   the watcher pauses on repeated auth failures.

**When revisiting:** confirm password-login actually works for this
account before building automation around it, and re-weigh whether the
convenience is worth the account-takeover blast radius vs. option 1.

## Token lifetime — one data point, not a confirmed TTL

Observed 2026-08-07: session token issued ~01:02 PKT held up until
~08:29 PKT (~7.5 hours) before every poll started failing with
`HTTP 400 {"meta":{"success":false,"message":"Resource not found"}}`.

Open question, unresolved: was that genuine token expiry, or Rolzo
rate-limiting/blocking after ~7.5 hours of continuous polling (the exact
"IP flagged" risk this whole halt-at-5-failures mechanism exists to avoid)?
Both would look identical from the frontend's side. Can't tell them apart
without more data points — e.g. does it fail again at a similar elapsed
time next run, or does timing vary? Worth logging/comparing across a few
real runs before treating ~7.5h as a real number to plan around.

## Partner accept flow — implemented 2026-08-08, NOT yet proven live

The original bot called the independent-driver endpoint (`POST
partners/{id}`) on partner bookings, which silently did nothing while
reporting success. Now routes on `isForPartner` → `POST
dispatch/{bookingId}/{supplierId}` with an empty body, and verifies the
result against the server instead of trusting the response. Full detail in
ARCHITECTURE.md.

**Not yet proven:** no live pending offer has gone through the corrected
path yet. The endpoint/payload are derived from Rolzo's own source and
corroborated by a real booking's `dispatch.link`, but the first real
attempt is still the actual test. Watch the next one closely.

**Not implemented:** the `isOperativeBranch` variant (`acceptOfferOp` →
`POST partner/localSupplier/{bookingId}` with `{supplierId, buyingPrice}`).
That flag was absent on this account's booking, so it appears not to apply
here — but if a booking ever shows up with it set, the bot would take the
wrong branch. It currently does not check for this.

**Second step not automated:** assigning a chauffeur after winning. Rolzo's
flow is accept-then-assign; the bot only does the accept, so a won booking
still needs a human to assign a driver (`external/chauffeur/assign/{id}`,
`external/confirm/assign/{id}` — traced but not built).

## Current priority

Get one real, verified win through the corrected partner flow. Until that
happens nothing else here is worth building.
