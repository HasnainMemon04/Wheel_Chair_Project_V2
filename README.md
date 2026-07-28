# Zettamight — Smart Wheelchair Platform (V2 web app)

A **new front end** for the existing smart-rental-wheelchair system. Same ESP32 hardware,
same Supabase project, same Edge Functions and command contract as
`Wheel_Chair_Project` — only the interface is new.

> `Wheel_Chair_Project` (V1) is **untouched**. This directory is self-contained.

## What this is

| | |
| --- | --- |
| Rider app | `/` — map, scan-to-select, hold-to-unlock, live ride, receipt, passes, help, profile |
| Operator console | `/ops` — fleet map, per-chair sensors, remote actions, rides/revenue, alerts + event log |

The design is ported from the Zettamight prototype in `../Wheel_Chair_Project/source/`
(`Zettamight Wheelchair Platform.dc.html` + `fleet-map.js`), rebuilt as real
Next.js pages driven by live device telemetry.

## Run it

```bash
npm install
cp .env.example .env.local   # then fill in your Supabase keys
npm run dev
```

Open <http://localhost:3000> for the rider app and <http://localhost:3000/ops> for the console.

`.env.local` points at the **same** Supabase project as V1, so both apps see the same
chairs, the same `device_state` rows written by the ESP32, and the same command queue.

## Architecture

```
ESP32 firmware ──HTTPS──> Supabase Edge Function /ingest ──> device_state, events
      ▲                                                          │
      │ commands (piggybacked on the /ingest response)            │ Realtime
      └──────────────── commands table <────── this web app ──────┘
```

- `lib/useFleetState.ts` — realtime subscription to `device_state` + `events`, with a
  full refetch on every (re)subscribe so a dropped socket can't leave stale rows.
- `lib/commands.ts` — `sendCommand()` inserts into `commands` and **waits for the
  device's ack**. No ack inside ~3.5 s renders as failure, never as success.
- `components/FleetMap.tsx` — React port of the prototype's Leaflet component
  (pin/arrow markers, dashed geofence, ride trail, pulsing "me" dot).

## Rules this app follows

From `../Wheel_Chair_Project/source/HANDOFF.md`:

- **Firmware is the authority.** The browser never decides safety. It sends an intent
  and renders the device's answer. Thermal cut-off, tamper latch, fall detection,
  geofence enforcement and relay permission all live on the ESP32.
- **Hold-to-confirm** for every physical action (`lib/useHold.ts`), tracked on a ref so a
  stray `pointercancel` can't latch the button.
- **Scan-first selection.** Tapping a map pin only locates a chair; only a scan (or a
  typed code) selects one to unlock.
- **Nearest means nearest.** Chairs are sorted by plain distance, excluding anything
  under 25 % battery. No hidden scoring.
- **Two-signal stop check** before a ride can end — GPS speed *and* the IMU motion flag.
- **Live fee is a display estimate.** SAR 15 unlock + SAR 1.50/min, capped at SAR 150/day;
  the authoritative invoice comes from the server when the ride closes.

## Accounts and access

Authentication is real Supabase Auth — email + password or Google. There is no
guest mode: every table the app reads is RLS-restricted to signed-in roles, so
a signed-out browser genuinely receives no fleet data.

Two roles, held in `public.profiles.role`:

| Role | Gets | How it is assigned |
| --- | --- | --- |
| `rider` | The rider app | Automatically, by the `on_auth_user_created` trigger |
| `operator` | `/ops` as well | Only by an existing operator or the service role |

A rider cannot promote itself: `profiles.role` is guarded by a trigger, and the
signup trigger hard-codes `'rider'` regardless of what the client sends.

`/ops` is gated in `proxy.ts` **before the route renders**, so it cannot be
reached by typing the URL. Operators signing in on the rider page are
redirected to the console automatically.

### What a rider may do

Riders can read the fleet and the service areas. They may issue only fail-safe
commands (`LOCK`, `END_SESSION`, `CLEAR_SOS`) and only on a chair they hold a
live rental for; `PING` is open so anyone can make a chair beep to find it.
**`UNLOCK` is not reachable from any browser** — it exists solely on the
service-role payment webhook.

## Maintenance mode

An operator can withdraw a chair from service in the chair's detail panel. It
writes `wheelchairs.out_of_service`, which is published over Realtime, so
rider devices drop the chair from availability within a second — no refresh.

The flag is merged onto the device row in `useFleetState`, so `statusOf()` and
`isRentable()` honour it everywhere at once rather than each call site having
to remember to check. It outranks connectivity: a withdrawn chair stays
withdrawn whether or not it is reporting.

## Deploying to Vercel

1. **Environment variables** — set all of `.env.example` in the Vercel project.
   `SUPABASE_SERVICE_ROLE_KEY` must be a plain (not `NEXT_PUBLIC_`) variable so
   it stays server-side. `.env.local` is gitignored and must never be committed.
2. **Supabase → Authentication → URL Configuration** — set the Site URL to the
   deployed origin and add `https://<your-domain>/auth/callback` to the
   redirect allow-list, or Google sign-in will fail with a redirect mismatch.
3. **Google provider** — enable it under Authentication → Providers and paste
   the OAuth client ID/secret from Google Cloud. The app asks the project which
   providers are live (`/auth/v1/settings`) and **hides the Google button until
   this is done**, so no rider is ever sent to a provider that is not
   configured. Enable it and the button appears on the next load — no code
   change and no redeploy.

   In Google Cloud → APIs & Services → Credentials, the OAuth client's
   *Authorised redirect URI* must be your Supabase callback, not your own
   domain: `https://<project-ref>.supabase.co/auth/v1/callback`.
4. **SMTP.** Email confirmation is ON, and Supabase's built-in sender is
   rate-limited to a handful of messages an hour — fine for testing, not for
   real signups. Set a real SMTP provider under Project Settings → Auth →
   SMTP before launch. Confirmation, password reset and resend all depend on
   it; none of them work reliably until it is configured.
5. **Server-side password floor.** The app refuses anything under 8 characters,
   but that is the client. Raise Authentication → Password → minimum length to
   8 so the API enforces the same rule for a caller that skips the UI.
6. Enable **leaked-password protection** (Authentication → Password) so
   passwords found in known breaches are rejected at signup.

## The account is the container

Everything a rider owns lives in Supabase against their user id, not in the
browser that happened to create it. Sign in on a new phone and the account
arrives intact; hand your phone to someone else and they see none of it.

| What | Where it lives |
| --- | --- |
| Identity, password, sessions | Supabase Auth (`auth.users`, bcrypt) |
| Name, phone, language, notification prefs | `public.profiles`, RLS `id = auth.uid()` |
| Profile photo | Supabase Storage, bucket `avatars`, path `<uid>/avatar.<ext>` |
| Ride history | `public.rentals`, RLS `user_id = auth.uid()` |

Storage RLS requires the first path segment to equal `auth.uid()`, so the
folder name is the access check itself, not a convention the client is trusted
to follow. Uploading into someone else's folder fails at the database.

Ride history reads from `rentals`, so it follows the account across devices.
The device's local record contributes only GPS-measured distance, which the
server does not store — a trip with no local match shows its duration and
omits distance rather than printing a confident `0 m`.

The portal covers: edit name and phone, upload or replace a photo, switch
language, toggle ride receipts and marketing email, change password, sign out
of all devices, and delete the account. Deleting removes the auth user and
profile; finished rentals survive with `user_id` set to NULL, because they are
billing records — and the account cannot be deleted mid-ride.

## Why signup goes through `/api/auth/signup`

`supabase.auth.signUp()` answers a repeat signup with a decoy `200` and quietly
re-sends a confirmation email. That is deliberate anti-enumeration, but with no
SMTP configured it produced a trap: a rider who already had an account was told
"check your inbox" forever, and the resends eventually rate-limited them out of
their own account with **"Too many attempts. Wait a moment and try again."**

The route fixes the cause rather than the wording:

- checks whether the address is registered **first** and answers `409 "That
  email already has an account"` — no send is attempted, so nothing is capped;
- applies `passwordProblem()` server-side, so the rules hold for a caller that
  skips the UI (the browser copy is the same module, `lib/passwordRules.ts`);
- throttles per IP (5 per 15 min) as its own backstop;
- creates the account already confirmed, so the rider is signed in immediately.

Set `AUTH_REQUIRE_EMAIL_CONFIRMATION=true` once real SMTP is configured to
require a clicked link instead. Everything else — reset, resend, recovery — is
unchanged and already speaks to Supabase directly.

## Email authentication

The full set of flows is implemented, not just sign-in:

| Flow | Where |
| --- | --- |
| Sign up (name + email + password) | Login screen → "New here?" |
| Sign in | Login screen |
| Forgot password → emailed reset link | Login screen → "Forgot your password?" |
| Set a new password from that link | Full-screen recovery step, takes priority over every other screen |
| Resend a confirmation email | Offered only after a signup that is waiting on one |

Details that matter:

- **Password rules** live in `passwordProblem()`: 8 character minimum, a
  common-password blocklist, no single repeated character, and the local part
  of the email cannot appear in the password. There is a strength meter that
  says *what is wrong*, not just how weak it is.
- **No account enumeration.** Password reset and resend always report success,
  even for an address with no account. Reporting "no such user" would turn
  either form into a way to test which addresses are registered, and the list
  of people who rent mobility aids is not one worth leaking.
- **A recovery link is a real session.** `/auth/callback?type=recovery`
  redirects into a dedicated "choose a new password" screen; without that the
  rider would silently land on the map, already signed in, never having set the
  password they came to change. Operators are held there too — the redirect to
  `/ops` waits until the reset finishes.
- The callback accepts both PKCE `?code=` and one-time `?token_hash=` links, so
  it works whichever form the project's email templates produce.

## Layout

```
proxy.ts            operator-role gate + security headers (runs before routes)
app/
  page.tsx          rider app (all rider screens)
  ops/page.tsx      operator console
  auth/callback/    OAuth + email-confirmation landing, exchanges code->session
  layout.tsx        Archivo font + theme provider
  globals.css       design tokens (modernist system) + keyframes
  api/              rental + payment route handlers (shared contract with V1)
components/
  FleetMap.tsx      Leaflet map
lib/
  supabase.ts       browser client (cookie sessions, same project as V1)
  supabaseServer.ts request-scoped clients for proxy + route handlers
  useAuth.ts        session, profile, role, sign in/up/out
  types.ts          DeviceState / FleetEvent / MapState / ChairStatus
  useFleetState.ts  live fleet data + maintenance flag merge
  commands.ts       ack-aware command dispatch
  useHold.ts        hold-to-confirm gesture
  format.ts         money, time, distance
  mapping.ts        device_state -> UI status/markers
```
