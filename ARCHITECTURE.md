# Rolzo Driver Portal — architecture trace

Derived entirely from `business.rolzo.com`'s own production JavaScript and
the exposed webpack source maps (`*.chunk.js.map`, served publicly, HTTP
200, no auth required — same as anyone's browser downloads on page load).
Reconstructed source lives in the session scratchpad; file/line refs below
are against that reconstructed tree, all under `src/`.

Every claim below is either **confirmed** (read directly in source, or
matched against the live network response you supplied) or flagged
**unknown** (backend-only behavior we can't see from the frontend).

## 1. How new bookings are delivered — confirmed: plain polling, human-triggered

The New Bookings screen (`router/routes/Driver/DriverApp/Bookings/NewBooking.jsx`)
fetches via the `useGetTableData` hook (`hooks/useGetTableData.js`), which
calls the list endpoint **once per mount / filter change / pagination
change**. There is no `setInterval` anywhere in that hook — it does not
auto-refresh on a timer.

The app does hold a live WebSocket (`wss://business.rolzo.com/web-socket`,
via `@giantmachines/redux-websocket`, see `middlewares/appWebsocketMiddleware.js`).
Its message handler only special-cases `booking_chat` / `chatInfo` payloads
— i.e. it drives the in-app chat system. The Redux reducer
(`reducers/appWebsocket.js`) *does* handle a `booking_added` /
`booking_list_summary_update` message type from the server, writing it to
`state.appWebsocket.bookingAdded` / `bookingListUpdate` — but **no
component in the driver frontend reads those fields**. It's dead state on
this screen (grepped the full reconstructed tree; zero consumers).

Net effect: on the web dashboard, a new booking becomes visible only when
a human is looking at (or reloads) the tab. There is no push notification
wired into this code path. This likely explains the 5-second losses better
than anything else — other drivers are plausibly using the native mobile
app, which *does* register for Firebase Cloud Messaging (`App.jsx`,
`registerFcm`) and can push-alert instantly; the web portal cannot.

**Practical implication:** there is no hidden faster channel to tap into.
A REST poller hitting the same endpoint the browser uses is already at (or
above) parity with what the web UI itself is capable of.

## 2. Endpoints

Base URL, confirmed against your captured request: `https://business.rolzo.com/api/api/v1/...`
(the doubled `/api/api/v1` comes from `REACT_APP_APIHOST=https://business.rolzo.com/api`
baked into the bundle, then the API client appends `/api/v1` itself — grepped
literal in `main.*.chunk.js`).

| Purpose | Method | Path | Source |
|---|---|---|---|
| List new bookings | GET | `external/partnerToken/{token}/new-booking` | `NewBooking.jsx:46`, matches your captured traffic exactly |
| List new bookings (rental) | GET | `external/partnerToken/{token}/new-booking-rentals` | `NewBooking.jsx:43` |
| List new bookings (meet & greet) | GET | `external/partnerToken/{token}/new-booking-meetGreet` | `NewBooking.jsx:45` |
| **Accept booking** | **POST** | **`partners/{bookingId}`** | `actions/partners.js:8` `acceptPartnerBooking` |
| Accept greeter action | POST | `partners/greeter/{bookingId}` | `actions/partners.js:15` |
| Decline dispatch offer | PATCH | `booking/cancelDispatchPartner/decline/{bookingId}/{supplierId}` | `actions/partners.js:47` |
| Partner/driver details (session bootstrap) | GET | `external/partnerToken/{token}` | `actions/partners.js:339` |
| Login (email+password, company/business users) | POST | `login` | `actions/auth.js:108` |
| Token validity check | POST | `checkAuthTokenValid` | `actions/auth.js:745` |
| FCM push token register | POST/PUT | `notification/fcm` | `actions/auth.js:695,712` |
| Presence heartbeat | (via createOrEditItem, POST) | `updateLastSeen/{userId}` | `actions/auth.js:764`, called every 5 min from `App.jsx` |
| WebSocket | — | `wss://business.rolzo.com/web-socket` | chat + admin ops counters only, confirmed unused for this screen |

## 3. Accept Booking — confirmed, exact payload

Same code path, same payload, in both the mobile card view
(`components/DriverBookingCard.jsx:68-86`) and the desktop table view
(`components/DriverBookingTable.jsx:78-90`):

```js
const onAcceptBooking = async bookingId => {
  setIsLoading(true)
  const obj = {
    action: 'accepted',
    geoLocation: '00.00-00.00',   // literal placeholder — not real GPS
    isLiveLocation: false,
  }
  const res = await acceptPartnerBooking(obj, bookingId) // POST partners/{bookingId}
  reloadList()
}
```

`geoLocation` is a **hardcoded placeholder string**, not the driver's real
location, despite the field name — the one-click "Accept booking" button
never calls `navigator.geolocation`. (A *different* flow, on the booking
**detail** page's driver-role accept button — `BookingDetails.jsx:603-647`
`onAcceptBookingDriver` — does request real GPS via
`navigator.geolocation.getCurrentPosition` and sends `isLiveLocation: true`
with real coordinates on success, falling back to the same placeholder on
permission denial. That's a separate, slower flow you're not using.)

**Validation / optimistic UI: none.** `reloadList()` fires unconditionally
after the request settles, whether it succeeded or the server rejected it
(e.g. booking already taken) — the UI's "confirmation" is just re-fetching
the authoritative list, not a local optimistic update. Whether the backend
enforces any format on `geoLocation`, or does anything beyond log it, is
**unknown** — that's server-side and not visible from here.

**`meta.success: true` does not mean you won the booking — confirmed and
root-caused 2026-08-08, booking #208829-R.** The accept POST returned HTTP
200, `meta.success: true`, and the *same* `data.status: "in_review"` /
`dispatchStatus: "dispatched"` as the pre-accept snapshot — completely
unchanged. The booking sat unaccepted until a human later manually accepted
and assigned it to a chauffeur through the real app.

**Root cause: the bot was calling the wrong endpoint entirely.** The list
item carries `isForPartner: true` (there is no `isForDriver` field on it at
all). Rolzo has two different accept flows and this account uses the one the
bot was *not* calling:

| | driver flow | partner/fleet flow ← **this account** |
|---|---|---|
| flag on booking | `isForDriver` | `isForPartner: true` |
| UI | one-click "Accept booking" on the card | "View" → details page → "Accept offer" |
| action | `acceptPartnerBooking()` | `acceptOffer()` |
| endpoint | `POST partners/{bookingId}` | `POST dispatch/{bookingId}/{supplierId}` |
| body | `{action:'accepted', geoLocation, isLiveLocation}` | `{}` |
| after accepting | done | **then** assign a chauffeur separately |

Posting the driver-flow payload at a partner booking returns a cheerful
`meta.success: true` and does nothing at all — no error, no state change.
That is exactly what made this look like a win.

`supplierId` is this company's own id, `MXkdhtpFtfeyEyPXL` ("The Royal
Limo") — confirmed live. Sourced the same way Rolzo's own
`BookingDetails.jsx` does it: `GET external/partner/{token}` → `data[0]._id`.
It also appears as `dispatch.supplierId` on an accepted booking, and matches
the `companyId` in `localStorage["RolzoCurrentUser"]`. The bot now resolves
it once at startup so the accept itself never pays for that round trip.

**Timing was never the problem.** Reconstructed from `dispatchedAt` vs. our
own logs for #208829-R: offer dispatched `23:32:13.619Z`, bot detected it
`23:32:15` (**1.38s** later), accept POST completed in **0.36s** — a total
reaction of ~1.7 seconds, to the wrong endpoint. Speed work would have
changed nothing here.

**Verification is no longer taken on trust.** After every accept the bot now
re-reads `GET external/partnerBooking/{bookingId}/{token}` and only reports a
win if `dispatch.supplierId` equals our own supplier id. A booking that is
ours reads `status: "confirmed"`, `dispatchStatus: "accepted"` (confirmed
against a real accepted booking). Anything else is reported as NOT WON, with
the name of whoever the booking actually went to when the server discloses it.

**Still unconfirmed:** the partner accept has not yet been exercised against
a live pending offer — the endpoint and payload come from Rolzo's own source
plus a matching `dispatch.link` on a real booking, but no automated win has
been observed yet. The `isOperativeBranch` variant (`acceptOfferOp` → `POST
partner/localSupplier/{bookingId}`) is not implemented; that flag was absent
on this account's booking.

## 3b. After winning: Planned tab + chauffeur assignment — verified 2026-08-08

**Planned tab** = `GET external/partnerToken/{token}/planned` (same
`useGetTableData` shape as New Bookings). Verified live: a booking we own
reads `status: "confirmed"`, `dispatchStatus: "accepted"`,
`isForPartner: true`, `chauffeurStatus: "no"` until a chauffeur is assigned.
This is what "it shows up in Planned" actually means at the API level.

**Win verification, positive-control tested.** Running the bot's
`verifyBookingOwnership()` against booking #208829-R (one we genuinely own)
returns `dispatch.supplierId === MXkdhtpFtfeyEyPXL` → `isOurs: true`. So the
check correctly identifies a real win, not just correctly rejecting a fake
one — both directions confirmed.

**Assignment is a separate multi-step flow** (all PATCH, from
`Assign.jsx` + `actions/partners.js`), which is why `chauffeurStatus` stays
`"no"` right after an accept:

| step | endpoint | body |
|---|---|---|
| 1. chauffeur | `external/chauffeur/assign/{bookingId}` | `{chauffeurId, token, action:'accepted', geoLocation:'00.00-00.00', isLiveLocation:false}` |
| 2. vehicle | `external/car/assign/{bookingId}` | `{vehicleId}` |
| 3. pickup info *(only if airportPickUpInfo/trainPickUpInfo)* | `external/pickup/assign/{bookingId}` | pickup instructions |
| 4. confirm | `external/confirm/assign/{bookingId}` | `{token, action:'accepted', geoLocation:'00.00-00.00', isLiveLocation:false}` |

Account currently has **6 chauffeurs** (`GET external/chauffeur/{token}`)
and **4 vehicles** (`GET external/car/{token}`) available to assign.
Not automated — see `TODO.md`.

## 4. Auth — confirmed

Every request (`api/index.js`, `ApiService.makeRequest`) attaches:

```
X-User-Id: <redux auth.userId>
X-Auth-Token: <redux auth.authToken>
Content-Type: application/json
```

pulled from Redux `auth` state, itself hydrated from
`localStorage["RolzoCurrentUser"]` on load. Session establishment for the
driver portal is a passwordless email-link flow (`AuthForm.jsx` + AES-256
encrypted `localtoken` query param decoded in `App.jsx`), separate from the
company/business `POST login` (email+password) path. WebSocket auth reuses
the same pair as connection subprotocols: `[userId, authToken]`
(`middlewares/appWebsocketMiddleware.js:26-33`).

## 5. What's unknown (backend-only, can't verify from frontend)

- Whether there's a rate limit on the list or accept endpoints, and what it is.
- Exact server-side race resolution when two drivers POST accept near-simultaneously (frontend just surfaces whatever `meta`/`message` comes back).
- Rolzo's automation/bot policy for the driver portal specifically (not present in frontend code — check their partner ToS/support directly).

## Permanent deployment

Run once: `powershell -ExecutionPolicy Bypass -File .\install-service.ps1`

Registers a Scheduled Task ("RolzoWatcher") that starts at logon, runs
hidden, and is restarted by Windows every minute if the process dies.
Verified 2026-08-10: killing the process led to Windows relaunching it
automatically.

Manage it:

```powershell
Get-ScheduledTask  -TaskName RolzoWatcher          # registered?
Start-ScheduledTask -TaskName RolzoWatcher         # start now
Stop-ScheduledTask  -TaskName RolzoWatcher         # stop now
Unregister-ScheduledTask -TaskName RolzoWatcher -Confirm:$false
Get-Content .\logs.txt -Wait -Tail 20              # live log
```

**Single-instance lock.** The watcher binds 127.0.0.1:47823 (the
credential-refresh endpoint) and treats that bind as a mutex: a second copy
sees EADDRINUSE, logs `duplicate_instance_exiting`, and exits *before*
polling. This matters because two live copies would double the request rate
against Rolzo and both race to accept the same booking. Verified by
launching a duplicate while one was running — it exited on its own.

**Log rotation.** `logs.txt` and `rolzo-watcher.log` rotate at 5 MB, keeping
one previous generation (`*.1`), so a permanent deployment stays bounded
(~400 KB/day at a 7s poll with per-minute heartbeats).

### Why this machine, and not a cloud VPS

The binding constraint is credential refresh, not uptime. The auth token
expires (~7.5 h observed once) and there is **no refresh endpoint** in
Rolzo's API — the only ways to get a fresh token are a real login, or
copying it out of a browser that is already logged in. The bookmarklet does
the latter, and it talks to `127.0.0.1`, i.e. it only works when the watcher
runs on the same machine as the browser.

So on a VPS the watcher would run 24/7 but go dead on the first token
expiry, with nobody able to click anything. Making a VPS genuinely viable
needs one of:

1. password-based auto-login (chosen in `TODO.md`, not built — see the
   account-takeover tradeoff documented there), or
2. exposing the refresh endpoint over the network (auth'd) so the
   bookmarklet can push tokens to a remote host, or
3. a scheduled headless-browser token extraction from a persistent
   logged-in profile.

Until one of those exists, "permanent" means *this PC, powered on and logged
in*. Sleep/shutdown = no watching.

## Running it unattended

1. `copy rolzo.local.env.example rolzo.local.env`, fill in real values. This
   file never leaves your machine and is never printed by the script.
2. Test with `DRY_RUN=1` set in `rolzo.local.env` first — confirms polling,
   detection, and the two Discord messages (posted / accepted) all work
   without actually committing to any booking. Watch a few real poll cycles
   before flipping `DRY_RUN` to `0`.
3. The script already restarts itself in-process on unexpected errors and
   logs every event to `rolzo-watcher.log`, but it still dies if you close
   the terminal window or reboot. To survive that, register it as a
   Scheduled Task that starts at logon (run once, from an elevated
   PowerShell, adjust the path if you moved the folder):

   ```powershell
   schtasks /create /tn "RolzoBookingWatcher" /tr "node \"C:\Users\hashi\OneDrive\Desktop\Rolzo Bot\rolzo-auto-accept.js\"" /sc onlogon /rl highest
   ```

   Check on it via `schtasks /query /tn "RolzoBookingWatcher"`, remove via
   `schtasks /delete /tn "RolzoBookingWatcher" /f`. `rolzo-watcher.log` is
   your record of what fired and whether each accept won, independent of
   whether you were watching Discord at the time.

## Verifying any of this yourself

Everything above came from files any browser downloads to render this
page — nothing required your login credentials. To re-verify or go
further:

```
curl -s https://business.rolzo.com/partner/driver/app/<token>/new-bookings
# → find the <script src=".../static/js/main.*.chunk.js"> tag
curl -s <that url>.map -o main.map   # source map, served alongside the bundle
# parse the .map JSON's `sources`/`sourcesContent` arrays to get the original files back
```
