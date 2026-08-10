#!/usr/bin/env node
/**
 * Rolzo Driver Portal — new-booking watcher / auto-accept client
 *
 * Reverse-engineered from business.rolzo.com's own production source maps
 * (webpack sourcesContent, publicly served alongside the JS bundles) and
 * cross-checked against the live network requests supplied by the account
 * owner. See ARCHITECTURE.md in this folder for the full trace.
 *
 * What the real frontend does, that this script reproduces:
 *   - New Bookings list  : GET  external/partnerToken/{token}/new-booking
 *   - Accept booking     : POST partners/{bookingId}
 *       body: { action: 'accepted', geoLocation: '00.00-00.00', isLiveLocation: false }
 *       (this is the exact literal the production "Accept booking" button
 *       sends from the list view — it does not read real GPS; only the
 *       booking-detail page's separate driver-accept flow does that.)
 *   - Auth                : every call carries X-Auth-Token / X-User-Id
 *       headers, sourced from the browser's own logged-in session.
 *
 * No browser is involved anywhere in this script. It calls the JSON API
 * directly over plain HTTPS — the same requests the React app's fetch()
 * calls make, minus the browser around them. That's deliberate: it's
 * faster than driving a real/headless browser (no page render, no DOM),
 * more reliable (depends on the JSON API shape, not CSS selectors that
 * break on a frontend redesign), and there's nothing to "detect" since
 * it's not impersonating a browser — it's sending your own authenticated
 * session's requests directly.
 *
 * There is NO faster channel than this REST endpoint for this screen: the
 * production web app does not use its WebSocket (wss://business.rolzo.com/
 * web-socket) or Firebase push for the New Bookings list — that socket only
 * carries chat events, and the "booking_added" message type it CAN carry is
 * written into Redux state but nothing in the driver frontend reads it.
 *
 * THIS SCRIPT AUTO-ACCEPTS WITH NO HUMAN CONFIRMATION. It will commit you to
 * a booking the instant it appears, whether or not you're actually free to
 * take it, and does so faster than any human could react. That is very
 * likely outside Rolzo's expected/allowed use of this endpoint. Run only
 * against your own account, and watch the first sessions closely.
 *
 * ---- Setup --------------------------------------------------------------
 *
 * 1. Copy rolzo.local.env.example -> rolzo.local.env and fill in your real
 *    values. rolzo.local.env is for secrets on THIS machine only — never
 *    paste tokens into chat, a commit, or anywhere shared.
 * 2. node rolzo-auto-accept.js
 *
 * Credentials: open business.rolzo.com in your browser while logged in,
 * open DevTools -> Application -> Local Storage -> "RolzoCurrentUser", and
 * pull `authToken` / `userId` from the stored JSON. ROLZO_PARTNER_TOKEN is
 * the path segment from your New Bookings URL
 * (.../driver/app/<PARTNER_TOKEN>/new-bookings).
 *
 * Discord: create a bot at discord.com/developers, invite it to your server
 * with "Send Messages" + "Embed Links" permission on the target channel,
 * then set DISCORD_BOT_TOKEN and DISCORD_CHANNEL_ID (right-click the
 * channel -> Copy Channel ID; needs Developer Mode on in Discord settings).
 *
 * DRY_RUN=1 logs detections without POSTing an accept — use this first to
 * confirm polling/detection/Discord all work before letting it commit to
 * real jobs.
 */

'use strict'

const https = require('https')
const http = require('http')
const fs = require('fs')
const path = require('path')

// ---- tiny local .env loader ---------------------------------------------
// No dependency needed for KEY=VALUE lines. Real secrets stay in
// rolzo.local.env, which is not something this script ever prints or logs.

function loadLocalEnv(file) {
  const p = path.join(__dirname, file)
  if (!fs.existsSync(p)) return
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (!(key in process.env)) process.env[key] = value
  }
}
loadLocalEnv('rolzo.local.env')

// ---- config ---------------------------------------------------------------

// let, not const: the refresh server (below) updates these live when the
// bookmarklet sends a fresh token, no restart needed.
let AUTH_TOKEN = process.env.ROLZO_AUTH_TOKEN
let USER_ID = process.env.ROLZO_USER_ID
const PARTNER_TOKEN = process.env.ROLZO_PARTNER_TOKEN
const PARTNER_TYPE = process.env.ROLZO_PARTNER_TYPE || 'chauffeur' // chauffeur | rental | meetGreet
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 10000)
const DRY_RUN = process.env.DRY_RUN === '1'
// Render (and most PaaS hosts) inject PORT and expect the app to bind it on
// 0.0.0.0. Local dev has neither set, so it falls back to the old default
// and stays 127.0.0.1-only (nothing off this machine can reach it).
const REFRESH_SERVER_PORT = Number(process.env.PORT || process.env.REFRESH_SERVER_PORT || 47823)
const BIND_HOST = process.env.PORT ? '0.0.0.0' : '127.0.0.1'
// Required once this server is reachable from the internet — see the check
// at the /update-creds handler for why. Optional locally (127.0.0.1-only
// already means nothing else on the machine's network can reach it).
const REFRESH_SECRET = process.env.REFRESH_SECRET || null

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || null
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || null
const DISCORD_ENABLED = !!(DISCORD_BOT_TOKEN && DISCORD_CHANNEL_ID)

const API_HOST = 'business.rolzo.com'
const API_BASE = '/api/api/v1' // matches the doubled /api/api/v1 baked into production
const DETAIL_URL_BASE = 'https://business.rolzo.com/partner/driver/app/details'

// ---- time formatting --------------------------------------------------------
// Everything user-facing (terminal, logs.txt, rolzo-watcher.log, Discord) is
// shown in Virginia time (America/New_York). Uses Intl rather than a fixed
// offset because that zone observes DST — it is EDT (UTC-4) in summer and
// EST (UTC-5) in winter, and a hardcoded offset would silently drift by an
// hour half the year. The zone name is printed so it is never ambiguous.

const DISPLAY_TZ = process.env.DISPLAY_TZ || 'America/New_York'

const tzParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: DISPLAY_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  timeZoneName: 'short',
})

function toDisplayTZ(date) {
  const parts = tzParts.formatToParts(date)
  const get = t => (parts.find(p => p.type === t) || {}).value || ''
  const hour = get('hour') === '24' ? '00' : get('hour') // Intl can emit 24 at midnight
  const date_ = `${get('year')}-${get('month')}-${get('day')}`
  const time = `${hour}:${get('minute')}:${get('second')}`
  const zone = get('timeZoneName')
  return {
    date: date_,
    time,
    zone,
    full: `${date_} ${time} ${zone}`,
    utcIso: date.toISOString(),
  }
}

function nowDisplayTZ() {
  return toDisplayTZ(new Date())
}

// Latency is tracked internally in ms (precise, easy to do math on) but shown
// to humans in seconds, per preference.
function fmtSeconds(ms) {
  return `${(ms / 1000).toFixed(2)}s`
}

if (!AUTH_TOKEN || !USER_ID || !PARTNER_TOKEN) {
  console.error(
    'Missing credentials. Set ROLZO_AUTH_TOKEN, ROLZO_USER_ID, ROLZO_PARTNER_TOKEN\n' +
      'in rolzo.local.env (copy rolzo.local.env.example) or as environment variables.\n' +
      'Pull authToken/userId from localStorage["RolzoCurrentUser"] in an authenticated browser session.'
  )
  process.exit(1)
}

const LIST_PATH_BY_TYPE = {
  chauffeur: `new-booking`,
  rental: `new-booking-rentals`,
  meetGreet: `new-booking-meetGreet`,
}

const listPath = `${API_BASE}/external/partnerToken/${PARTNER_TOKEN}/${LIST_PATH_BY_TYPE[PARTNER_TYPE]}?page=1&limit=40`

// ---- logging --------------------------------------------------------------
// rolzo-watcher.log gets clean JSON lines (one event per line, easy to grep
// or parse later). The terminal gets a colored, emoji-tagged, human-scannable
// version of the same events so you can tell what happened without reading
// raw objects.

const LOG_FILE = path.join(__dirname, 'rolzo-watcher.log')
const TXT_LOG_FILE = path.join(__dirname, 'logs.txt')

// Running permanently means these files grow forever (~400KB/day at a 10s
// poll with a per-minute heartbeat). Rotate at 5MB, keeping one previous
// generation, so disk use stays bounded without losing recent history.
const MAX_LOG_BYTES = 5 * 1024 * 1024
function rotateIfLarge(file) {
  try {
    if (!fs.existsSync(file)) return
    if (fs.statSync(file).size < MAX_LOG_BYTES) return
    const prev = `${file}.1`
    if (fs.existsSync(prev)) fs.unlinkSync(prev)
    fs.renameSync(file, prev)
  } catch (err) {
    // Never let logging problems take the watcher down.
    console.error('log rotation failed:', err.message)
  }
}

// Ground truth capture: field names used elsewhere in this script (and in
// Rolzo's own React components) are inferred from how the UI *consumes* the
// response, not from a real observed payload — there's been no booking to
// look at yet. The first real ones we see get dumped here in full, so that
// inference gets replaced with fact instead of staying an assumption.
const RAW_DIR = path.join(__dirname, 'raw-captures')
function dumpRaw(name, data) {
  try {
    if (!fs.existsSync(RAW_DIR)) fs.mkdirSync(RAW_DIR)
    fs.writeFile(path.join(RAW_DIR, `${name}.json`), JSON.stringify(data, null, 2), err => {
      if (err) log('raw_capture_write_failed', { name, error: err.message })
    })
  } catch (err) {
    log('raw_capture_write_failed', { name, error: err.message })
  }
}

const COLOR = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
}

const EVENT_STYLE = {
  startup: { tag: '🚀 START', color: COLOR.cyan },
  detected: { tag: '🔔 NEW BOOKING', color: COLOR.yellow },
  accepted: { tag: '✅ WON', color: COLOR.green },
  accept_rejected: { tag: '❌ MISSED', color: COLOR.red },
  accept_no_effect: { tag: '❌ NOT WON', color: COLOR.red },
  accept_not_supported: { tag: '🙋 MANUAL ACTION NEEDED', color: COLOR.yellow },
  accept_attempt: { tag: '⚡ ACCEPTING', color: COLOR.cyan },
  accept_unverified: { tag: '❓ UNVERIFIED — CHECK MANUALLY', color: COLOR.yellow },
  accept_blocked_no_supplier_id: { tag: '🛑 ACCEPT BLOCKED', color: COLOR.red },
  supplier_id_resolved: { tag: '🏢 SUPPLIER ID', color: COLOR.cyan },
  supplier_id_missing: { tag: '⚠️  SUPPLIER ID MISSING', color: COLOR.red },
  supplier_id_error: { tag: '⚠️  SUPPLIER ID ERROR', color: COLOR.red },
  duplicate_instance_exiting: { tag: '👥 ALREADY RUNNING — exiting', color: COLOR.yellow },
  accept_request_failed: { tag: '⚠️  ACCEPT ERROR', color: COLOR.red },
  dry_run_accept_skipped: { tag: '🧪 DRY RUN', color: COLOR.gray },
  poll_unexpected_response: { tag: '⏳ POLL ISSUE', color: COLOR.yellow },
  poll_error: { tag: '🔥 POLL ERROR', color: COLOR.red },
  fatal_loop_error_restarting: { tag: '🔥 CRASH — RESTARTING', color: COLOR.red },
  uncaught_exception: { tag: '🔥 UNCAUGHT ERROR', color: COLOR.red },
  unhandled_rejection: { tag: '🔥 UNHANDLED REJECTION', color: COLOR.red },
  discord_notify_failed: { tag: '⚠️  DISCORD FAILED', color: COLOR.gray },
  discord_notify_error: { tag: '⚠️  DISCORD ERROR', color: COLOR.gray },
  shutdown: { tag: '🛑 STOP', color: COLOR.cyan },
  heartbeat: { tag: '💓 alive', color: COLOR.gray },
  auth_alert_sent: { tag: '⚠️  AUTH WARNING', color: COLOR.yellow },
  halted_after_repeated_failures: { tag: '🛑 PAUSED — AUTH', color: COLOR.red },
  resumed: { tag: '▶️  RESUMED', color: COLOR.green },
  refresh_server_listening: { tag: '🔑 REFRESH SERVER UP', color: COLOR.cyan },
  refresh_server_error: { tag: '🔥 REFRESH SERVER ERROR', color: COLOR.red },
  refresh_unauthorized: { tag: '🚫 UNAUTHORIZED REFRESH ATTEMPT', color: COLOR.red },
  discord_command: { tag: '💬 DISCORD COMMAND', color: COLOR.cyan },
  discord_gateway_ready: { tag: '💬 DISCORD LISTENING', color: COLOR.cyan },
  discord_gateway_closed: { tag: '💬 DISCORD DISCONNECTED', color: COLOR.gray },
  discord_gateway_error: { tag: '⚠️  DISCORD GATEWAY ERROR', color: COLOR.red },
  discord_command_error: { tag: '⚠️  DISCORD COMMAND ERROR', color: COLOR.red },
  discord_gateway_reply_failed: { tag: '⚠️  DISCORD REPLY FAILED', color: COLOR.gray },
  creds_refreshed: { tag: '🔑 CREDS UPDATED', color: COLOR.green },
  creds_refresh_error: { tag: '⚠️  CREDS REFRESH FAILED', color: COLOR.red },
}

function summarize(event, data) {
  switch (event) {
    case 'detected':
      return `#${data.number ?? data.bookingId} — ${data.vehicle || 'n/a'} — flow:${data.flow} — posted ${data.postedAt || 'n/a'} — seen ${data.detectionLag || 'n/a'} later — pickup ${data.pickUpDate || 'n/a'} — ${data.price ?? 'n/a'}`
    case 'accept_attempt':
      return `#${data.label || data.bookingId} — flow:${data.flow} — POST ${data.endpoint} — body ${JSON.stringify(data.body)}`
    case 'accepted':
      return `#${data.label || data.bookingId} in ${fmtSeconds(data.ms)} (verify done at ${fmtSeconds(data.totalMs)}) — CONFIRMED ours: status="${data.verifiedStatus}" dispatch="${data.verifiedDispatchStatus}"`
    case 'accept_rejected':
      return `#${data.label || data.bookingId} after ${fmtSeconds(data.ms)} — ${data.reason} — full response: ${JSON.stringify(data.response)}`
    case 'accept_no_effect':
      return `#${data.label || data.bookingId} after ${fmtSeconds(data.ms)} — flow:${data.flow} httpOk:${data.httpOk} — server says status="${data.verifiedStatus}" dispatch="${data.verifiedDispatchStatus}" dispatchedTo=${data.dispatchedTo || 'nobody'} — NOT ours — response: ${JSON.stringify(data.response)}`
    case 'accept_unverified':
      return `#${data.label || data.bookingId} after ${fmtSeconds(data.ms)} — flow:${data.flow} httpOk:${data.httpOk} — could NOT verify (${data.verifyError}) — CHECK MANUALLY — response: ${JSON.stringify(data.response)}`
    case 'accept_blocked_no_supplier_id':
      return `#${data.label || data.bookingId} — no supplierId resolved, partner accept impossible`
    case 'accept_not_supported':
      return `#${data.label || data.bookingId} — neither isForPartner nor isForDriver — unknown flow, handle manually`
    case 'supplier_id_resolved':
      return `${data.companyName || ''} -> ${data.supplierId}`
    case 'accept_request_failed':
      return `#${data.label || data.bookingId} after ${fmtSeconds(data.ms)} — ${data.error}${data.stack ? '\n' + data.stack : ''}`
    case 'poll_unexpected_response':
      return `HTTP ${data.status} — body: ${data.body || '(empty)'} — check ROLZO_PARTNER_TOKEN / auth in rolzo.local.env`
    case 'heartbeat':
      return `${data.successfulPolls} polls so far, no new bookings — still watching`
    case 'refresh_server_listening':
      return `http://127.0.0.1:${data.port}/update-creds — click the refresh bookmarklet any time to update credentials`
    case 'creds_refreshed':
      return data.wasHalted ? 'watcher was paused — resuming polling now' : 'saved, watcher was already running fine'
    case 'resumed':
      return data.reason || ''
    case 'paused':
      return `${data.reason}${data.by ? ' (by ' + data.by + ')' : ''}`
    case 'discord_command':
      return `!${data.command} from ${data.by}`
    case 'discord_gateway_closed':
      return `code ${data.code}${data.code === 4014 ? ' — Message Content Intent not enabled in Discord Developer Portal' : ''}`
    default:
      return Object.keys(data).length ? JSON.stringify(data) : ''
  }
}

// Tracked here (not in the Discord Gateway section below) so log() can
// update it regardless of load order — every event flows through log().
const PROCESS_STARTED_AT = Date.now()
let lastEventSummary = 'none yet'
const SUMMARY_WORTHY_EVENTS = new Set([
  'detected',
  'accepted',
  'accept_no_effect',
  'accept_unverified',
  'accept_rejected',
  'accept_not_supported',
  'accept_request_failed',
  'accept_blocked_no_supplier_id',
  'paused',
  'resumed',
  'halted_after_repeated_failures',
  'creds_refreshed',
])

function log(event, data) {
  const t = nowDisplayTZ()
  // JSON log keeps BOTH: UTC for unambiguous machine parsing/sorting, and the
  // Virginia-time string that matches what the terminal and logs.txt show, so
  // a line can always be cross-referenced between the three.
  const line = { ts: t.utcIso, tsLocal: t.full, event, ...data }

  const style = EVENT_STYLE[event] || { tag: event, color: COLOR.gray }
  const detail = summarize(event, data)
  const plainTag = style.tag.replace(/^\W+\s*/, '') // strip the leading emoji for the plain-text file

  // Feeds !status in Discord — only the events someone would actually care
  // to see at a glance, not every heartbeat/poll-issue.
  if (SUMMARY_WORTHY_EVENTS.has(event)) {
    lastEventSummary = `${t.time} ${t.zone} — ${plainTag}${detail ? ': ' + detail : ''}`
  }

  console.log(
    `${COLOR.dim}${t.time} ${t.zone}${COLOR.reset} ${style.color}${COLOR.bold}${style.tag}${COLOR.reset}${detail ? '  ' + detail : ''}`
  )

  // rolzo-watcher.log: one JSON object per line, for parsing/tooling.
  rotateIfLarge(LOG_FILE)
  rotateIfLarge(TXT_LOG_FILE)
  fs.appendFile(LOG_FILE, JSON.stringify(line) + '\n', err => {
    if (err) console.error('log write failed:', err.message)
  })

  // logs.txt: everything, plain text, human-readable — open it in Notepad.
  fs.appendFile(TXT_LOG_FILE, `${t.full}  ${plainTag}${detail ? '  ' + detail : ''}\n`, err => {
    if (err) console.error('logs.txt write failed:', err.message)
  })
}

// ---- generic HTTPS JSON helper --------------------------------------------

function httpsJson({ host, path: reqPath, method, headers, body }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null
    const req = https.request(
      {
        host,
        path: reqPath,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
        timeout: 10000,
      },
      res => {
        let raw = ''
        res.on('data', chunk => (raw += chunk))
        res.on('end', () => {
          let json = null
          try {
            json = raw ? JSON.parse(raw) : null
          } catch (e) {
            json = null
          }
          resolve({ status: res.statusCode, json, raw })
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('request timed out')))
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function rolzoRequest(method, reqPath, body) {
  return httpsJson({
    host: API_HOST,
    path: reqPath,
    method,
    headers: { 'X-Auth-Token': AUTH_TOKEN, 'X-User-Id': USER_ID },
    body,
  })
}

// ---- Discord notifications --------------------------------------------------
// Fire-and-forget: a Discord outage must never slow down or block an accept.

function discordEmbed(embed) {
  if (!DISCORD_ENABLED) return
  embed.timestamp = new Date().toISOString() // Discord renders this in each viewer's own local time
  // Explicit Virginia-time footer so the intended reference timezone is on the
  // message itself, regardless of whose device is reading it.
  if (!embed.footer) embed.footer = { text: `${nowDisplayTZ().full}` }
  httpsJson({
    host: 'discord.com',
    path: `/api/v10/channels/${DISCORD_CHANNEL_ID}/messages`,
    method: 'POST',
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      'User-Agent': 'RolzoBookingWatcher (local script, 1.0)',
    },
    body: { embeds: [embed] },
  })
    .then(({ status, raw }) => {
      if (status >= 300) log('discord_notify_failed', { status, body: raw.slice(0, 300) })
    })
    .catch(err => log('discord_notify_error', { error: err.message }))
}

function notifyPosted(item, detailUrl) {
  discordEmbed({
    title: `New booking — #${item.number || item._id}`,
    url: detailUrl,
    color: 0xf5a623, // Rolzo's own "pending" amber
    description: 'Detected on the New Bookings feed. Attempting accept now.',
    fields: [
      { name: 'Vehicle', value: `${item.vehicleBrand || ''} ${item.vehicleModel || ''}`.trim() || 'n/a', inline: true },
      // Deliberately UTC, not local: Rolzo's own app displays pickUpDate with
      // moment.utc(...) (confirmed in their source) — matching that avoids a
      // mismatch against what you'd see if you opened the booking in Rolzo
      // itself, which matters more here than tool-log consistency.
      { name: 'Pick-up (as shown in Rolzo, UTC)', value: item.pickUpDate ? new Date(item.pickUpDate).toUTCString() : 'n/a', inline: true },
      { name: 'Price', value: item.dispatchPrice != null ? `${item.dispatchPrice} ${item.dispatchCurrency || ''}` : 'n/a', inline: true },
      // "Posted at" = when Rolzo dispatched this offer to us, plus how long
      // it took us to see it. That lag is the honest measure of whether the
      // poll interval is costing races.
      { name: 'Offer posted at', value: postedAtLabel(item), inline: true },
      { name: 'Seen after', value: detectionLagLabel(item), inline: true },
      { name: 'Flow', value: item.isForPartner ? 'partner (company accept)' : item.isForDriver ? 'driver (one-click)' : 'unknown', inline: true },
      { name: 'From', value: (item.pickUpLocation && item.pickUpLocation.fullAddress) || 'n/a' },
      { name: 'To', value: (item.dropOffLocation && item.dropOffLocation.fullAddress) || 'n/a' },
    ],
  })
}

// dispatchedAt is when the offer actually landed with us; everything else
// (dispatchDate/autoDispatched) relates to earlier dispatch stages.
function postedAtSource(item) {
  const raw = item.dispatchedAt || item.dispatchDate || item.autoDispatched || null
  if (!raw) return null
  const d = new Date(raw)
  return isNaN(d.getTime()) ? null : d
}

function postedAtLabel(item) {
  const d = postedAtSource(item)
  return d ? toDisplayTZ(d).full : 'n/a'
}

function detectionLagLabel(item) {
  const d = postedAtSource(item)
  if (!d) return 'n/a'
  return `${fmtSeconds(Date.now() - d.getTime())} after posting`
}

function notifyAccepted(item, detailUrl, { won, reason, ms, verification }) {
  const fields = [
    { name: 'Vehicle', value: `${item.vehicleBrand || ''} ${item.vehicleModel || ''}`.trim() || 'n/a', inline: true },
    { name: 'Price', value: item.dispatchPrice != null ? `${item.dispatchPrice} ${item.dispatchCurrency || ''}` : 'n/a', inline: true },
    { name: 'Offer posted at', value: postedAtLabel(item), inline: true },
  ]
  if (verification) {
    fields.push({
      name: 'Verified on server',
      value:
        `status: ${verification.status || 'n/a'}\n` +
        `dispatch: ${verification.dispatchStatus || 'n/a'}\n` +
        `dispatched to: ${verification.dispatchedSupplierName || verification.dispatchedSupplierId || 'nobody yet'}`,
    })
  }
  discordEmbed({
    title: won ? `✅ WON — #${item.number || item._id}` : `❌ NOT WON — #${item.number || item._id}`,
    url: detailUrl,
    color: won ? 0x2f7d4f : 0xc23b3b,
    description: won
      ? `Accepted in ${fmtSeconds(ms)} and **confirmed on Rolzo's own record** as dispatched to us.` +
        `\n\nNext step: assign a chauffeur to this booking in the app.`
      : `Did not get it (accept call took ${fmtSeconds(ms)}) — ${reason || 'unknown reason'}.`,
    fields,
  })
}

// ---- Discord Gateway — listens for !start / !stop / !status ----------------
// Everything above is outbound-only (plain REST POSTs). Receiving commands
// needs the Gateway (a WebSocket), a different Discord API. Node 20+ has a
// built-in WebSocket global (via undici), so this needs no dependency.
//
// Requires the bot's "Message Content Intent" to be turned ON in the Discord
// Developer Portal (Bot tab -> Privileged Gateway Intents) — off by default,
// and without it every message arrives with an empty .content no matter what
// intents are requested here.

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${sec}s` : `${sec}s`
}

function sendChannelMessage(channelId, content) {
  return httpsJson({
    host: 'discord.com',
    path: `/api/v10/channels/${channelId}/messages`,
    method: 'POST',
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      'User-Agent': 'RolzoBookingWatcher (local script, 1.0)',
    },
    body: { content },
  }).catch(err => log('discord_gateway_reply_failed', { error: err.message }))
}

async function replyStatus(channelId) {
  const t = nowDisplayTZ()
  const stateLine =
    pauseReason === 'manual'
      ? '🛑 STOPPED (by !stop)'
      : pauseReason === 'auth'
      ? '🛑 PAUSED (repeated auth failures)'
      : '✅ RUNNING'

  const recentLog = fs.existsSync(TXT_LOG_FILE)
    ? fs
        .readFileSync(TXT_LOG_FILE, 'utf8')
        .trim()
        .split('\n')
        .slice(-8)
        .join('\n')
    : '(no log file yet)'

  const lines = [
    `**${stateLine}**`,
    `Mode: ${DRY_RUN ? 'DRY RUN (detects, does not accept)' : 'LIVE (auto-accepts)'}`,
    `Now: ${t.full}`,
    `Uptime: ${fmtDuration(Date.now() - PROCESS_STARTED_AT)}`,
    `Successful polls: ${successfulPollCount}`,
    `Supplier ID resolved: ${SUPPLIER_ID ? 'yes (' + SUPPLIER_ID + ')' : 'no'}`,
    `Last activity: ${lastEventSummary}`,
    '',
    `Real log, last ${Math.min(8, recentLog.split('\n').length)} lines:`,
    '```',
    recentLog.length > 1800 ? recentLog.slice(-1800) : recentLog,
    '```',
  ]
  await sendChannelMessage(channelId, lines.join('\n'))
}

async function handleDiscordMessage(msg) {
  if (!msg.author || msg.author.bot) return // never react to bots, including ourselves
  if (DISCORD_CHANNEL_ID && msg.channel_id !== DISCORD_CHANNEL_ID) return
  const content = (msg.content || '').trim().toLowerCase()

  if (content === '!status') {
    log('discord_command', { command: 'status', by: msg.author.username })
    await replyStatus(msg.channel_id)
  } else if (content === '!stop') {
    log('discord_command', { command: 'stop', by: msg.author.username })
    const did = pause('manual', { by: msg.author.username })
    await sendChannelMessage(
      msg.channel_id,
      did ? '🛑 Stopped. Will not poll or accept anything until `!start`.' : 'Already stopped.'
    )
  } else if (content === '!start') {
    log('discord_command', { command: 'start', by: msg.author.username })
    const did = resume(`discord !start by ${msg.author.username}`)
    await sendChannelMessage(msg.channel_id, did ? '▶️ Started. Watching for new bookings again.' : 'Already running.')
  }
}

const GATEWAY_INTENTS = (1 << 0) | (1 << 9) | (1 << 15) // GUILDS, GUILD_MESSAGES, MESSAGE_CONTENT
let gatewayWs = null
let gatewayHeartbeatTimer = null
let gatewaySeq = null
let gatewayReconnectDelayMs = 2000

function gatewayHeartbeat() {
  if (gatewayWs && gatewayWs.readyState === WebSocket.OPEN) {
    gatewayWs.send(JSON.stringify({ op: 1, d: gatewaySeq }))
  }
}

function gatewayIdentify() {
  gatewayWs.send(
    JSON.stringify({
      op: 2,
      d: {
        token: DISCORD_BOT_TOKEN,
        intents: GATEWAY_INTENTS,
        properties: { os: 'linux', browser: 'rolzo-watcher', device: 'rolzo-watcher' },
      },
    })
  )
}

function connectDiscordGateway() {
  if (!DISCORD_ENABLED) return
  let ws
  try {
    ws = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json')
  } catch (err) {
    log('discord_gateway_error', { error: err.message })
    setTimeout(connectDiscordGateway, gatewayReconnectDelayMs)
    return
  }
  gatewayWs = ws

  ws.addEventListener('message', event => {
    let msg
    try {
      msg = JSON.parse(event.data)
    } catch (e) {
      return
    }
    const { op, d, s, t } = msg
    if (s != null) gatewaySeq = s

    if (op === 10) {
      // HELLO: start heartbeating (with jitter, per Discord's docs), then identify.
      const interval = d.heartbeat_interval
      setTimeout(gatewayHeartbeat, interval * Math.random())
      gatewayHeartbeatTimer = setInterval(gatewayHeartbeat, interval)
      gatewayIdentify()
    } else if (op === 0) {
      // DISPATCH
      if (t === 'READY') {
        gatewayReconnectDelayMs = 2000
        log('discord_gateway_ready', {})
      } else if (t === 'MESSAGE_CREATE') {
        handleDiscordMessage(d).catch(err => log('discord_command_error', { error: err.message }))
      }
    } else if (op === 7 || op === 9) {
      // RECONNECT requested, or INVALID_SESSION — simplest correct response is
      // a fresh reconnect+re-identify rather than implementing RESUME.
      ws.close()
    }
  })

  ws.addEventListener('close', event => {
    clearInterval(gatewayHeartbeatTimer)
    log('discord_gateway_closed', { code: event.code })
    gatewayReconnectDelayMs = Math.min(gatewayReconnectDelayMs * 1.5, 30000)
    setTimeout(connectDiscordGateway, gatewayReconnectDelayMs)
  })

  ws.addEventListener('error', err => {
    log('discord_gateway_error', { error: (err && err.message) || 'unknown' })
  })
}

// ---- core loop --------------------------------------------------------------

const seen = new Set() // booking _id values we've already reacted to this run

function beep() {
  process.stdout.write('\x07') // audible terminal bell as a local backup to Discord
}

// Our own company's supplier id — required by the partner/fleet accept
// endpoint. Rolzo's own BookingDetails.jsx sources it the same way:
//   useGetTableData(`external/partner/${token}`) -> data.list[0]._id
// Fetched once at startup (and lazily retried) so the accept itself never
// pays for this round trip mid-race.
let SUPPLIER_ID = null

async function fetchSupplierId() {
  try {
    const { status, json } = await rolzoRequest('GET', `${API_BASE}/external/partner/${PARTNER_TOKEN}`)
    const id = json && json.data && json.data[0] && json.data[0]._id
    const name = json && json.data && json.data[0] && json.data[0].name
    if (id) {
      SUPPLIER_ID = id
      log('supplier_id_resolved', { supplierId: id, companyName: name })
    } else {
      log('supplier_id_missing', { status, response: json })
    }
  } catch (err) {
    log('supplier_id_error', { error: err.message })
  }
  return SUPPLIER_ID
}

// Ground truth: never trust the accept response's own claim of success.
// Re-reads the booking and reports who (if anyone) it is now dispatched to.
async function verifyBookingOwnership(bookingId) {
  const { status, json } = await rolzoRequest(
    'GET',
    `${API_BASE}/external/partnerBooking/${bookingId}/${PARTNER_TOKEN}`
  )
  const b = (json && json.data) || {}
  const dispatch = b.dispatch || null
  return {
    httpStatus: status,
    status: b.status,
    dispatchStatus: b.dispatchStatus,
    dispatchedSupplierId: dispatch && dispatch.supplierId,
    dispatchedSupplierName: dispatch && dispatch.name,
    // The decisive check: is this booking dispatched to *us*?
    isOurs: !!(dispatch && SUPPLIER_ID && dispatch.supplierId === SUPPLIER_ID),
    raw: b,
  }
}

async function acceptBooking(item) {
  const bookingId = item._id
  const label = `#${item.number || bookingId} ${item.vehicleBrand || ''} ${item.vehicleModel || ''}`.trim()
  const detailUrl = `${DETAIL_URL_BASE}/${PARTNER_TOKEN}/${bookingId}`

  if (DRY_RUN) {
    log('dry_run_accept_skipped', { bookingId, label })
    return
  }

  // Route to the flow this account/booking actually uses. Confirmed against
  // Rolzo's own source + a real booking (#208829-R) on 2026-08-08:
  //
  //   isForPartner  -> "Accept offer" on the details page, which calls
  //                    acceptOffer() -> POST dispatch/{bookingId}/{supplierId}
  //                    with an empty body. This is a company/fleet accept:
  //                    you take the job first, then assign a chauffeur to it
  //                    afterwards as a separate step.
  //   isForDriver   -> the one-click "Accept booking" card button, which
  //                    calls acceptPartnerBooking() -> POST partners/{id}.
  //                    That is the INDEPENDENT-DRIVER flow.
  //
  // The original bug: this bot always used the independent-driver endpoint.
  // On a partner booking that returns a cheerful meta.success:true and does
  // absolutely nothing, which is why #208829-R was logged as WON while the
  // offer actually sat there until a human accepted it manually.
  let endpoint
  let body
  let flow

  if (item.isForPartner) {
    if (!SUPPLIER_ID) await fetchSupplierId()
    if (!SUPPLIER_ID) {
      log('accept_blocked_no_supplier_id', { bookingId, label })
      notifyAccepted(item, detailUrl, {
        won: false,
        reason: 'could not resolve our supplierId, so the partner accept endpoint could not be called',
        ms: 0,
      })
      return
    }
    flow = 'partner'
    endpoint = `${API_BASE}/dispatch/${bookingId}/${SUPPLIER_ID}`
    body = {}
  } else if (item.isForDriver) {
    flow = 'driver'
    endpoint = `${API_BASE}/partners/${bookingId}`
    body = { action: 'accepted', geoLocation: '00.00-00.00', isLiveLocation: false }
  } else {
    log('accept_not_supported', { bookingId, label })
    discordEmbed({
      title: `🙋 MANUAL ACTION NEEDED — #${item.number || bookingId}`,
      url: detailUrl,
      color: 0xf5a623,
      description:
        'This booking is neither isForPartner nor isForDriver, so the right accept flow is unknown. ' +
        'Open it and accept manually, fast. The full payload is saved in raw-captures/ for diagnosis.',
    })
    return
  }

  log('accept_attempt', { bookingId, label, flow, endpoint, body })

  const startedAt = Date.now()
  try {
    const { status, json, raw } = await rolzoRequest('POST', endpoint, body)
    const ms = Date.now() - startedAt
    const httpOk = json && json.meta && json.meta.success

    // Verify against the server's own record rather than believing the
    // response. This is the check that would have caught the false "WON".
    let verification = null
    let verifyError = null
    try {
      verification = await verifyBookingOwnership(bookingId)
    } catch (err) {
      verifyError = err.message
    }

    dumpRaw(`${bookingId}-accept-response`, {
      flow,
      endpoint,
      requestBody: body,
      httpStatus: status,
      response: json,
      rawText: raw,
      verification,
      verifyError,
    })

    const totalMs = Date.now() - startedAt

    if (verification && verification.isOurs) {
      log('accepted', {
        bookingId,
        label,
        flow,
        ms,
        totalMs,
        verifiedStatus: verification.status,
        verifiedDispatchStatus: verification.dispatchStatus,
      })
      notifyAccepted(item, detailUrl, { won: true, ms, verification })
    } else if (verification) {
      // The request may have "succeeded" at the HTTP level, but the booking
      // is not dispatched to us — so we did not get it. Say so plainly, and
      // include who did get it when the server tells us.
      const takenBy = verification.dispatchedSupplierName || verification.dispatchedSupplierId || null
      log('accept_no_effect', {
        bookingId,
        label,
        flow,
        ms,
        httpOk: !!httpOk,
        verifiedStatus: verification.status,
        verifiedDispatchStatus: verification.dispatchStatus,
        dispatchedTo: takenBy,
        response: json,
      })
      notifyAccepted(item, detailUrl, {
        won: false,
        reason: takenBy
          ? `booking is dispatched to "${takenBy}", not us`
          : `booking still not dispatched to us (status "${verification.status}" / dispatch "${verification.dispatchStatus}")`,
        ms,
        verification,
      })
    } else {
      // Could not verify — report honestly as unknown rather than guessing.
      log('accept_unverified', {
        bookingId,
        label,
        flow,
        ms,
        httpOk: !!httpOk,
        verifyError,
        response: json,
      })
      notifyAccepted(item, detailUrl, {
        won: false,
        reason: `accept sent (HTTP ${status}) but ownership could not be verified: ${verifyError}. CHECK MANUALLY.`,
        ms,
      })
    }
  } catch (err) {
    const ms = Date.now() - startedAt
    // Network-level failure (timeout, connection reset, DNS, etc.) — no HTTP
    // response exists to capture, so the stack is the useful diagnostic here.
    log('accept_request_failed', { bookingId, label, flow, endpoint, ms, error: err.message, stack: err.stack })
    notifyAccepted(item, detailUrl, { won: false, reason: err.message, ms })
  }
}

// ---- pause / resume ---------------------------------------------------------
// One mechanism, two triggers: repeated auth failures pause it automatically,
// and a Discord "!stop" pauses it on request. Both go through the same park
// point in pollLoop — `pauseReason` records WHY so !status and the resume
// logic can tell them apart. Deliberately separate from `stopping`, which is
// only for a real process shutdown (SIGINT) — a pause keeps the process (and
// the Discord/refresh listeners) alive, just idles the polling itself.
let pauseReason = null // null = running; 'auth' | 'manual'
let resumeResolver = null
let consecutiveFailures = 0
let authAlertSent = false
const FAILURE_WARN_THRESHOLD = 3
const FAILURE_HALT_THRESHOLD = 5

function waitUntilResumed() {
  return new Promise(resolve => {
    resumeResolver = resolve
  })
}

function pause(reason, meta) {
  if (pauseReason) return false // already paused for some reason
  pauseReason = reason
  log('paused', { reason, ...meta })
  return true
}

// onlyIfReason: resume only clears a pause that matches this reason, so e.g.
// a token refresh can't accidentally un-pause a deliberate "!stop" — only an
// explicit "!start" (or another auth-fix) should do that.
function resume(reason, onlyIfReason) {
  if (!pauseReason) return false
  if (onlyIfReason && pauseReason !== onlyIfReason) return false
  const was = pauseReason
  pauseReason = null
  consecutiveFailures = 0
  authAlertSent = false
  log('resumed', { reason, wasPausedFor: was })
  if (resumeResolver) {
    resumeResolver()
    resumeResolver = null
  }
  return true
}

function onPollFailure(status) {
  consecutiveFailures += 1

  if (consecutiveFailures === FAILURE_WARN_THRESHOLD && !authAlertSent) {
    authAlertSent = true
    log('auth_alert_sent', { consecutiveFailures, status })
    discordEmbed({
      title: '⚠️ Watcher may be stuck — check your token',
      color: 0xc23b3b,
      description:
        `${consecutiveFailures} polls in a row returned HTTP ${status} instead of 200.\n` +
        `Most likely cause: ROLZO_AUTH_TOKEN / ROLZO_USER_ID in rolzo.local.env has expired ` +
        `or gone stale. Still retrying — will pause automatically at ${FAILURE_HALT_THRESHOLD} ` +
        `failures to avoid hammering Rolzo with a dead token. Click the refresh bookmarklet to ` +
        `fix it instantly.`,
    })
  }

  if (consecutiveFailures >= FAILURE_HALT_THRESHOLD) {
    log('halted_after_repeated_failures', { consecutiveFailures, status })
    discordEmbed({
      title: '🛑 Watcher PAUSED — repeated auth failures',
      color: 0xc23b3b,
      description:
        `${consecutiveFailures} consecutive failed polls (last: HTTP ${status}). Paused polling ` +
        `so we don't hammer Rolzo's servers / risk this IP getting rate-limited or flagged.\n\n` +
        `Fix: click the Rolzo token-refresh bookmarklet while logged in — it'll resume ` +
        `automatically, no restart needed. Or send \`!start\` in Discord. Or manually update ` +
        `rolzo.local.env and restart.`,
    })
    pause('auth', { consecutiveFailures, status })
  }
}

// A successful poll with no new bookings logs nothing by design — that's
// the normal, common outcome and logging it every 10s would be pure noise.
// But total silence is indistinguishable from "did this die quietly", so
// drop one low-key heartbeat roughly once a minute as proof of life.
let successfulPollCount = 0
const HEARTBEAT_EVERY_N_POLLS = Math.max(1, Math.round(60000 / POLL_INTERVAL_MS))

function onPollSuccess() {
  consecutiveFailures = 0
  authAlertSent = false
  successfulPollCount += 1
  if (successfulPollCount % HEARTBEAT_EVERY_N_POLLS === 0) {
    log('heartbeat', { successfulPolls: successfulPollCount })
  }
}

async function pollOnce() {
  const { status, json, raw } = await rolzoRequest('GET', listPath)
  if (status !== 200 || !json || !json.data) {
    const body = json ? JSON.stringify(json) : (raw || '').slice(0, 500)
    log('poll_unexpected_response', { status, body })
    dumpRaw(`poll-failure-${Date.now()}`, { status, response: json, rawText: raw })
    onPollFailure(status)
    return
  }
  onPollSuccess()

  const items = json.data.filter(Boolean)
  for (const item of items) {
    if (!item._id || seen.has(item._id)) continue
    seen.add(item._id)

    const detailUrl = `${DETAIL_URL_BASE}/${PARTNER_TOKEN}/${item._id}`
    dumpRaw(`${item._id}-detected`, item)
    beep()
    log('detected', {
      bookingId: item._id,
      number: item.number,
      vehicle: `${item.vehicleBrand || ''} ${item.vehicleModel || ''}`.trim(),
      pickUpDate: item.pickUpDate,
      price: item.dispatchPrice,
      flow: item.isForPartner ? 'partner' : item.isForDriver ? 'driver' : 'unknown',
      postedAt: postedAtLabel(item),
      detectionLag: detectionLagLabel(item),
      isForPartner: !!item.isForPartner,
      isForDriver: !!item.isForDriver,
      status: item.status,
      dispatchStatus: item.dispatchStatus,
    })
    notifyPosted(item, detailUrl)

    // Fire the accept immediately — no confirmation step, per configured
    // mode. Not awaited here so a slow Discord call (already
    // fire-and-forget) or a second item in the same batch can't delay
    // this one's accept. acceptBooking() picks the right flow per booking.
    acceptBooking(item)
  }
}

let stopping = false

async function pollLoop() {
  while (!stopping) {
    if (pauseReason) {
      await waitUntilResumed() // parks here with zero requests sent until resumed
      continue
    }
    const t0 = Date.now()
    try {
      await pollOnce()
    } catch (err) {
      log('poll_error', { error: err.message })
    }
    const elapsed = Date.now() - t0
    const wait = Math.max(0, POLL_INTERVAL_MS - elapsed)
    await new Promise(r => setTimeout(r, wait))
  }
}

// ---- credential refresh server ----------------------------------------------
// Localhost-only (bound to 127.0.0.1, never reachable off this machine). Lets
// the token-refresh bookmarklet push a fresh authToken/userId here with one
// click instead of manually editing rolzo.local.env and restarting. Updates
// the in-memory credentials immediately, persists them to rolzo.local.env so
// a future restart also has them, and resumes the poll loop right away if it
// was paused waiting for exactly this.

function updateLocalEnvFile(updates) {
  const p = path.join(__dirname, 'rolzo.local.env')
  let lines = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n') : []
  const keys = Object.keys(updates)
  const seenKeys = new Set()

  lines = lines.map(line => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return line
    const eq = trimmed.indexOf('=')
    if (eq === -1) return line
    const key = trimmed.slice(0, eq).trim()
    if (keys.includes(key)) {
      seenKeys.add(key)
      return `${key}=${updates[key]}`
    }
    return line
  })

  for (const key of keys) {
    if (!seenKeys.has(key)) lines.push(`${key}=${updates[key]}`)
  }

  fs.writeFileSync(p, lines.join('\n'))
}

function startRefreshServer() {
  return new Promise(resolve => {
  const server = http.createServer((req, res) => {
    // GET /health — unauthenticated on purpose: this is what Render's own
    // health check and whatever external uptime pinger you point at this
    // service hit to keep it from spinning down. No credentials, no state
    // change, nothing worth protecting.
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          ok: true,
          state: pauseReason ? `paused:${pauseReason}` : 'running',
          dryRun: DRY_RUN,
          uptimeSeconds: Math.floor((Date.now() - PROCESS_STARTED_AT) / 1000),
        })
      )
      return
    }

    // Only Rolzo's own origin is allowed to actually complete the POST (the
    // CORS preflight below blocks anything else at the browser level before
    // it ever reaches this handler).
    const origin = req.headers.origin || ''
    const allowOrigin = /^https:\/\/([a-z0-9-]+\.)*rolzo\.com$/i.test(origin) ? origin : 'https://business.rolzo.com'

    res.setHeader('Access-Control-Allow-Origin', allowOrigin)
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Refresh-Secret')
    res.setHeader('Access-Control-Allow-Private-Network', 'true') // Chrome Private Network Access preflight

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (req.method !== 'POST' || req.url !== '/update-creds') {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
      return
    }

    // CORS only stops a *browser* from completing a cross-origin request —
    // it does nothing against a direct curl/script. That's an acceptable gap
    // when this only ever binds 127.0.0.1 (nothing off the machine can reach
    // it at all), but once this is internet-facing (Render), it's the only
    // thing standing between "anyone who finds the URL" and hijacking the
    // account this bot acts as. REFRESH_SECRET closes that gap; only skipped
    // when explicitly unset, which is the accepted local-dev-only tradeoff.
    if (REFRESH_SECRET && req.headers['x-refresh-secret'] !== REFRESH_SECRET) {
      log('refresh_unauthorized', { ip: req.socket.remoteAddress })
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }

    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', () => {
      try {
        const { authToken, userId } = JSON.parse(body || '{}')
        if (!authToken || !userId) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'authToken and userId are required' }))
          return
        }

        AUTH_TOKEN = authToken
        USER_ID = userId
        updateLocalEnvFile({ ROLZO_AUTH_TOKEN: authToken, ROLZO_USER_ID: userId })

        // onlyIfReason: 'auth' — a fresh token should not override a
        // deliberate "!stop"; that still needs an explicit "!start".
        const wasHalted = resume('credentials refreshed via bookmarklet', 'auth')
        log('creds_refreshed', { wasHalted })
        discordEmbed({
          title: '🔑 Credentials refreshed',
          color: 0x2f7d4f,
          description: wasHalted
            ? 'New token received — watcher was paused, resuming polling now.'
            : 'New token received and saved.',
        })

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, resumed: wasHalted }))
      } catch (err) {
        log('creds_refresh_error', { error: err.message })
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
      }
    })
  })

    server.listen(REFRESH_SERVER_PORT, BIND_HOST, () => {
      log('refresh_server_listening', { port: REFRESH_SERVER_PORT, host: BIND_HOST, authRequired: !!REFRESH_SECRET })
      resolve()
    })

    server.on('error', err => {
      // EADDRINUSE means another copy of this watcher already owns the port —
      // i.e. it is already running. Two instances is actively harmful: both
      // poll (doubling request rate against Rolzo, which is exactly what the
      // rate-limit caution exists to avoid) and both would fire an accept for
      // the same booking. So the port doubles as a single-instance lock, and
      // the loser exits instead of quietly running as a duplicate.
      if (err.code === 'EADDRINUSE') {
        log('duplicate_instance_exiting', { port: REFRESH_SERVER_PORT })
        stopping = true
        process.exit(0)
        return
      }
      // Any other bind failure: the watcher itself is still useful without
      // the refresh endpoint, so carry on rather than refusing to run.
      log('refresh_server_error', { error: err.message })
      resolve()
    })
  })
}

// Crash resilience: if something outside pollOnce's own try/catch still
// throws, log it, alert Discord, and restart the loop after a short delay
// instead of the process silently dying and going dark.
async function main() {
  while (!stopping) {
    try {
      await pollLoop()
    } catch (err) {
      log('fatal_loop_error_restarting', { error: err.message, stack: err.stack })
      discordEmbed({
        title: '⚠️ Watcher crashed — restarting',
        color: 0xc23b3b,
        description: `${err.message}\nRestarting in 5s.`,
      })
      await new Promise(r => setTimeout(r, 5000))
    }
  }
}

// Refuse to boot in the one genuinely dangerous configuration: bound to all
// interfaces (i.e. reachable from the internet, as on Render) with no
// REFRESH_SECRET — that would let anyone who finds the URL POST arbitrary
// credentials to /update-creds and hijack which Rolzo account this bot acts
// as. Fine locally (127.0.0.1 bind already means nothing else can reach it).
if (BIND_HOST === '0.0.0.0' && !REFRESH_SECRET) {
  console.error(
    'Refusing to start: bound to 0.0.0.0 (internet-facing) with no REFRESH_SECRET set.\n' +
      'Set REFRESH_SECRET to a long random value in your environment variables before deploying.'
  )
  process.exit(1)
}

process.on('uncaughtException', err => log('uncaught_exception', { error: err.message, stack: err.stack }))
process.on('unhandledRejection', err => log('unhandled_rejection', { error: err && err.message }))

process.on('SIGINT', () => {
  log('shutdown', {})
  stopping = true
  process.exit(0)
})

log('startup', {
  listPath,
  pollIntervalMs: POLL_INTERVAL_MS,
  dryRun: DRY_RUN,
  discordEnabled: DISCORD_ENABLED,
  refreshServerPort: REFRESH_SERVER_PORT,
  displayTimezone: DISPLAY_TZ,
})

if (DISCORD_ENABLED) {
  discordEmbed({
    title: DRY_RUN ? '👀 Watcher online (DRY RUN — will not accept)' : '👀 Watcher online (LIVE — will auto-accept)',
    color: DRY_RUN ? 0x8b959e : 0x2f7d4f,
    description: `Polling every ${POLL_INTERVAL_MS}ms. Times shown in ${DISPLAY_TZ}. If this is the only message you see for a while, that's expected — it means no new bookings yet.`,
  })
}

// Bind the refresh server FIRST and wait for the result: it doubles as the
// single-instance lock, so nothing else should run until we know we are the
// only copy. Otherwise a duplicate would poll (and possibly accept) during
// the window before its EADDRINUSE fires.
connectDiscordGateway()
startRefreshServer()
  .then(fetchSupplierId) // resolve supplierId up front; mid-race lookups cost time we don't have
  .then(main)
