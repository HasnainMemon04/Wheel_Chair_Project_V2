'use client';

import Image from 'next/image';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import { useTheme } from './providers';
import { supabase } from '../lib/supabase';
import { sendCommand } from '../lib/commands';
import { useFleetState } from '../lib/useFleetState';
import { useAuth, passwordProblem, passwordScore } from '../lib/useAuth';
import { useGeofences } from '../lib/useGeofences';
import { useHold } from '../lib/useHold';
import {
  DAY_CAP,
  PER_MIN,
  UNLOCK_FEE,
  distanceM,
  estimateFee,
  fmtDist,
  mmss,
  sar,
  walkMins,
} from '../lib/format';
import {
  STATUS_META,
  battLabel,
  fencePolygon,
  isOnline,
  isRentable,
  isStationary,
  realSpeedKmh,
  rangeLabel,
  shortId,
  statusOf,
  toUnits,
} from '../lib/mapping';
import type { DeviceState, MapState, MapUnit, MapZone } from '../lib/types';
import { serverNow } from '../lib/clock';
import { PositionSmoother, type ResolvedPosition } from '../lib/position';

// Leaflet needs `window`, so the map is browser-only. Because of that this whole
// page file has to be a client component (Next 16 forbids ssr:false in a server one).
const FleetMap = dynamic(() => import('../components/FleetMap'), { ssr: false });

/* ------------------------------------------------------------------ *
 * Static reference data (places and copy — never sensor values)
 * ------------------------------------------------------------------ */

interface Site {
  key: string;
  label: string;
  short: string;
  lat: number;
  lng: number;
}

const SITES: Site[] = [
  { key: 'MAKKAH_HARAM', label: 'Makkah — Al Haram', short: 'Makkah', lat: 21.4225, lng: 39.8262 },
  { key: 'MAKKAH_JABAL', label: 'Makkah — Jabal Omar', short: 'Makkah', lat: 21.4184, lng: 39.8203 },
  { key: 'MADINAH_NABAWI', label: 'Madinah — Al Masjid an Nabawi', short: 'Madinah', lat: 24.4672, lng: 39.6112 },
];

const DEPOT_PHONE = '+966920000000';
// Mirrors the firmware's TILT_FALL_DEG. Used only to word the alert ("fall"
// vs generic emergency stop) — the interlock itself is decided on the device.
const FALL_TILT_DEG = 50;
const RIDE_DURATION_S = 1800; // the session length the firmware is asked to hold open
const UNLOCK_HOLD_MS = 900;
const END_HOLD_MS = 1200;
const DEVICE_WAIT_MS = 8000; // how long we wait for the chair to report the new state
const SITE_RADIUS_M = 25000;

const ICON = {
  map: '<path d="M9 3.5 3.5 6v14.5L9 18l6 2.5 5.5-2.5V3.5L15 6z"/><path d="M9 3.5V18M15 6v14.5"/>',
  pass: '<rect x="2.5" y="6.5" width="19" height="11" rx="3"/><path d="M8 6.5v11M16 6.5v11"/>',
  help: '<path d="M21 12a9 9 0 1 1-3.2-6.9"/><path d="M9.6 9.2a2.6 2.6 0 1 1 3.6 2.4c-.8.4-1.2 1-1.2 1.9"/><path d="M12 17.4h.01"/>',
  profile: '<circle cx="12" cy="9" r="3.4"/><path d="M4.8 20c1.5-3.7 4.1-5.5 7.2-5.5S17.7 16.3 19.2 20"/><circle cx="12" cy="12" r="9.2"/>',
  wallet: '<rect x="3" y="6" width="18" height="13" rx="3"/><path d="M3 10h18M16.5 14.5h2"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
  inbox: '<path d="M4 6.5h9l7 5.5-7 5.5H4z"/><path d="M4 6.5V19"/>',
  card: '<rect x="2.5" y="5.5" width="19" height="13" rx="3"/><path d="M2.5 10h19"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3.2 2"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3.2 9.5h17.6M3.2 14.5h17.6M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.4 8.2-8 9.5C7.4 20.2 4 17 4 12V6z"/><path d="M9.2 12.2l2 2 3.6-3.8"/>',
  helmet: '<path d="M3.5 13a8.5 8.5 0 0 1 17 0v1.5H3.5z"/><path d="M8 14.5v3h5"/>',
  person: '<circle cx="12" cy="7" r="3"/><path d="M6 20c0-3.6 2.7-6 6-6s6 2.4 6 6z"/>',
  slow: '<circle cx="12" cy="12" r="9"/><path d="M8.5 12h7"/>',
  park: '<path d="M6 20V4h5.5a4.5 4.5 0 0 1 0 9H6"/>',
  bolt: '<path d="M13 2 4.5 14H10l-1 8 9.5-12H13z"/>',
  chart: '<path d="M3 12h3.5l2.5 6 4-14 2.5 8H21"/>',
  lock: '<rect x="4" y="10.5" width="16" height="11" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1.6"/><rect x="14" y="3" width="7" height="7" rx="1.6"/><rect x="3" y="14" width="7" height="7" rx="1.6"/><path d="M14 14h3v3h-3zM19.5 14v3M14 19.5h3M19.5 19.5h1.5"/>',
  chair:
    '<circle cx="10" cy="3.6" r="1.7"/><path d="M10 7.5v5.2h5.4l2.6 6"/><path d="M8.2 11.4a5.2 5.2 0 1 0 6.1 7.2"/><path d="M18 19.4h2.6"/>',
  scanFrame: '<path d="M4 8V5h3M20 8V5h-3M4 16v3h3M20 16v3h-3"/><path d="M4 12h16"/>',
  fit: '<path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4"/>',
  navigate: '<path d="M3 11l18-8-8 18-2-8z"/>',
  pin: '<path d="M12 21s-7-5.6-7-11a7 7 0 1 1 14 0c0 5.4-7 11-7 11z"/><circle cx="12" cy="10" r="2.4"/>',
  bell: '<path d="M12 3a5 5 0 0 1 5 5v5l2 3H5l2-3V8a5 5 0 0 1 5-5z"/><path d="M9.5 19.5a2.5 2.5 0 0 0 5 0"/>',
  headset:
    '<path d="M12 3a9 9 0 0 1 9 9v5a3 3 0 0 1-3 3h-2"/><path d="M3 17v-5a9 9 0 0 1 9-9"/><rect x="2" y="12" width="4" height="6" rx="2"/><rect x="18" y="12" width="4" height="6" rx="2"/>',
  star: '<path d="M12 3l2.4 5 5.6.8-4 4 .9 5.6L12 15.8 7.1 18.4 8 12.8l-4-4L9.6 8z"/>',
  route: '<path d="M4 20h5v-5h5v-5h6"/><path d="M17 5h4v4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/>',
} as const;

interface HowStep {
  title: string;
  body: string;
  icon: string;
}

const HOW_STEPS: HowStep[] = [
  {
    title: 'Find a chair near you',
    body: 'The map shows every free wheelchair around you. The closest one is offered first, or tap any marker on the map to look at it.',
    icon: ICON.map,
  },
  {
    title: 'Scan the code on the handle',
    body: 'Point your phone at the square code printed on the handle. Scanning is the only way to choose a chair, so you always take the one standing in front of you.',
    icon: ICON.qr,
  },
  {
    title: 'Hold to unlock',
    body: 'Press and hold the unlock button. SAR 15 to unlock, then SAR 1.50 for every minute. The chair beeps and releases its brake when it opens.',
    icon: ICON.lock,
  },
  {
    title: 'Park inside the area, then hold to end',
    body: 'Leave the chair in a marked bay inside the area drawn on the map. Come to a full stop, then hold the end button. Your receipt appears straight away.',
    icon: ICON.receipt,
  },
];

const RULES: { icon: string; text: string }[] = [
  { icon: ICON.person, text: 'One person per chair, and never carry a passenger.' },
  { icon: ICON.slow, text: 'Keep to walking speed in crowds around the mataf.' },
  { icon: ICON.park, text: 'Park only in the marked bays so others can find it.' },
  { icon: ICON.globe, text: 'Stay inside the area drawn on the map.' },
  { icon: ICON.shield, text: 'Press Get help any time — staff can see where you are.' },
];

const FAQ: { q: string; a: string }[] = [
  {
    q: 'How do I unlock a chair?',
    a: 'Tap Scan and point your phone at the code on the handle. Once the chair is scanned, hold the unlock button — the chair itself decides whether it may open, and the app waits for its answer.',
  },
  {
    q: 'What happens if the battery runs low?',
    a: 'The chair keeps working but slows down. Park it at any marked bay and take another one — you are only charged for the time you actually rode.',
  },
  {
    q: 'Can I leave the area on the map?',
    a: 'No. If you cross the dashed line the chair slows itself to a stop and the depot is told, so please stay inside it.',
  },
  {
    q: 'Why will the ride not end?',
    a: 'The chair has to report that it is standing still on both its speed sensor and its motion sensor. If it refuses, come to a complete stop, park level, and hold the button again.',
  },
];

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

type Screen = 'login' | 'ready' | 'how' | 'rules' | 'app';
type Tab = 'map' | 'pass' | 'help' | 'profile' | 'trips';
type GeoState = 'prompt' | 'asking' | 'granted' | 'denied' | 'unavailable';
type CamState = 'prompt' | 'live' | 'denied' | 'done';
type UnlockStage = 'idle' | 'creating' | 'paying' | 'waiting';

interface Session {
  id: string;
  email: string;
  name: string;
  onboarded: boolean;
}

interface Ride {
  chairId: string;
  startedAt: number;
}

interface Trip {
  id: string;
  at: number;
  chairId: string;
  seconds: number;
  meters: number;
  fee: number;
}

interface RentalCreateResponse {
  ok?: boolean;
  rental?: { id: string };
  error?: string;
}

interface WebhookResponse {
  ok?: boolean;
  unlocked?: boolean;
  message?: string;
  error?: string;
}

// Identity itself lives in the Supabase session cookie; the only thing worth
// keeping in localStorage is whether this rider has already seen the intro.
const ONBOARDED_KEY = 'zm-v2-onboarded';
// Both are scoped per account (`key:${userId}`): a phone is shared hardware,
// an account is not. Without the scope, the next rider to sign in on the same
// device would inherit the previous rider's trips and live ride.
const TRIPS_KEY = 'zm-v2-trips';
const RIDE_KEY = 'zm-v2-ride';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJson<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function makeId(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `zm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function nameFromEmail(email: string): string {
  const local = (email.split('@')[0] || 'rider').split(/[._-]/)[0];
  return local.charAt(0).toUpperCase() + local.slice(1);
}

/**
 * Four-segment strength bar. Shows what is wrong rather than only how weak it
 * is, because "Weak" alone gives someone nothing to act on.
 */
function PasswordMeter({ password }: { password: string }): React.JSX.Element | null {
  if (!password) return null;
  const score = passwordScore(password);
  const problem = passwordProblem(password);
  const COLORS = ['#c23417', '#c23417', '#b8860b', '#1f9d55', '#1f9d55'];
  const LABELS = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 4 }} aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            style={{
              flex: 1,
              height: 4,
              borderRadius: 999,
              background: i < score ? COLORS[score] : 'color-mix(in srgb, var(--ink) 14%, transparent)',
              transition: 'background .2s ease',
            }}
          />
        ))}
      </div>
      <span style={{ fontSize: 12, color: problem ? 'var(--accent-600)' : 'var(--muted)' }}>
        {problem ?? LABELS[score]}
      </span>
    </div>
  );
}

// The site list is passed in because it comes from the operator's live
// geofence zones, not a constant. SITES is only the fallback for a database
// with no zones drawn yet.
function nearestSite(lat: number, lng: number, sites: Site[]): { site: Site; metres: number } {
  const list = sites.length ? sites : SITES;
  let best = list[0];
  let bestM = Number.POSITIVE_INFINITY;
  for (const s of list) {
    const m = distanceM([lat, lng], [s.lat, s.lng]);
    if (m < bestM) {
      bestM = m;
      best = s;
    }
  }
  return { site: best, metres: bestM };
}

function siteKeyOf(d: DeviceState, sites: Site[]): string | null {
  if (typeof d.lat !== 'number' || typeof d.lng !== 'number') return null;
  const { site, metres } = nearestSite(d.lat, d.lng, sites);
  // Assignment is by NEAREST area with a generous cap. The zone's own radius
  // is the device's enforcement boundary, not a listing filter — a chair
  // parked just outside a small zone should still be findable, not invisible.
  return metres > SITE_RADIUS_M ? null : site.key;
}

function posOf(d: DeviceState | null | undefined): [number, number] | null {
  if (!d || typeof d.lat !== 'number' || typeof d.lng !== 'number') return null;
  return [d.lat, d.lng];
}

function trailLength(points: [number, number][]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distanceM(points[i - 1], points[i]);
  return total;
}

function whenLabel(at: number): string {
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const yesterday = new Date(today.getTime() - 86400000);
  if (sameDay) return `Today ${hh}:${mm}`;
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${hh}:${mm}`;
  return `${d.getDate()} ${d.toLocaleString('en', { month: 'short' })} ${hh}:${mm}`;
}

function Icon({
  d,
  size = 24,
  stroke = 'currentColor',
  width = 1.7,
  style,
}: {
  d: string;
  size?: number;
  stroke?: string;
  width?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={stroke}
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flex: 'none', ...style }}
      dangerouslySetInnerHTML={{ __html: d }}
    />
  );
}

function Chevron({
  dir = 'right',
  size = 20,
  color = 'currentColor',
  style,
}: {
  dir?: 'right' | 'left' | 'down';
  size?: number;
  color?: string;
  style?: CSSProperties;
}) {
  const path = dir === 'left' ? 'M15 5l-7 7 7 7' : dir === 'down' ? 'M6 9l6 6 6-6' : 'M9 5l7 7-7 7';
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={2.2}
      aria-hidden="true"
      style={{ flex: 'none', ...style }}
    >
      <path d={path} />
    </svg>
  );
}

/* ------------------------------------------------------------------ *
 * Rider app
 * ------------------------------------------------------------------ */

export default function RiderApp() {
  const router = useRouter();
  const { theme, toggle: toggleTheme } = useTheme();
  const { deviceStates, loading, error: fleetError } = useFleetState();
  // Named service areas drawn by the operator, rendered read-only on the map.
  const { zones } = useGeofences();

  // ---- session / navigation -------------------------------------------------
  const [booted, setBooted] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [screen, setScreen] = useState<Screen>('login');
  const [tab, setTab] = useState<Tab>('map');
  const [howStep, setHowStep] = useState(0);

  // ---- sign in --------------------------------------------------------------
  const {
    user,
    displayName,
    isOperator,
    googleEnabled,
    recovering,
    loading: authLoading,
    signIn: signInAuth,
    signUp,
    signInWithGoogle,
    signOut: authSignOut,
    signOutEverywhere,
    requestPasswordReset,
    updatePassword,
    resendConfirmation,
    updateProfile,
    uploadAvatar,
    markOnboarded,
    profileLoaded,
    onboarded,
    profile,
  } = useAuth();
  const [email, setEmail] = useState('');
  const [pass, setPass] = useState('');
  const [newName, setNewName] = useState('');
  const [mode, setMode] = useState<'signin' | 'signup' | 'reset'>('signin');
  // Set when the rider arrived from a reset link (see /auth/callback).
  const [recoveryParam, setRecoveryParam] = useState(false);
  // Offered only after a signup that is waiting on an emailed confirmation.
  const [awaitingConfirm, setAwaitingConfirm] = useState('');
  const [emailOpen, setEmailOpen] = useState(false);
  const [authError, setAuthError] = useState('');
  const [authNotice, setAuthNotice] = useState('');
  const [signingIn, setSigningIn] = useState(false);

  // ---- map / selection ------------------------------------------------------
  const [siteKey, setSiteKey] = useState<string>(SITES[0].key);
  const [previewId, setPreviewId] = useState<string | null>(null); // tapping a pin only LOCATES
  const [chosenId, setChosenId] = useState<string | null>(null); // only a scan SELECTS
  const [zoom, setZoom] = useState(16);
  const [fit, setFit] = useState(0);
  const [recenter, setRecenter] = useState(0);

  // ---- geolocation ----------------------------------------------------------
  const [geo, setGeo] = useState<[number, number] | null>(null);
  const [geoState, setGeoState] = useState<GeoState>('prompt');
  const [geoNote, setGeoNote] = useState('');

  // ---- ride -----------------------------------------------------------------
  const [ride, setRide] = useState<Ride | null>(null);
  const [trail, setTrail] = useState<[number, number][]>([]);
  const [now, setNow] = useState(() => serverNow());
  const [unlockStage, setUnlockStage] = useState<UnlockStage>('idle');
  const [ending, setEnding] = useState(false);
  const [ringing, setRinging] = useState(false);
  const [clearingEmergency, setClearingEmergency] = useState(false);
  const [riderError, setRiderError] = useState('');
  const [receipt, setReceipt] = useState<Trip | null>(null);
  const [trips, setTrips] = useState<Trip[]>([]);

  // ---- overlays -------------------------------------------------------------
  const [scanOpen, setScanOpen] = useState(false);
  const [cam, setCam] = useState<CamState>('prompt');
  const [manualOpen, setManualOpen] = useState(false);
  const [riderCode, setRiderCode] = useState('');
  const [cityOpen, setCityOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);

  // ---- account portal -------------------------------------------------------
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [portalMsg, setPortalMsg] = useState('');
  const [portalErr, setPortalErr] = useState('');
  const [pwOpen, setPwOpen] = useState(false);
  const [newPw, setNewPw] = useState('');
  const [savingPw, setSavingPw] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [helpOpen, setHelpOpen] = useState<number | null>(null);
  const [toast, setToast] = useState('');

  // Language is a profile field now, not component state, so it follows the
  // account to every device instead of resetting on each new browser.
  const lang = profile?.locale === 'ar' ? 'العربية' : 'English';

  // ---- refs -----------------------------------------------------------------
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const statesRef = useRef<DeviceState[]>([]);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scanTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busyRef = useRef(false); // one unlock / one end at a time
  const avatarInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    statesRef.current = deviceStates;
  }, [deviceStates]);

  const say = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 3200);
  }, []);

  /* ---------------- boot ----------------------------------------------------
     Nothing account-shaped restores here any more: trips and the live ride are
     keyed by user id, so they can only be read once auth says who this is
     (see the effect below). */
  useEffect(() => {
    setBooted(true);
  }, []);

  const uid = session?.id ?? null;

  /* ---------------- account ride history (server-side) ----------------------
     The account is the container, not the phone: rentals carry user_id, RLS
     limits the select to the caller's own rows, and this device merely renders
     them. Sign in anywhere and the same history follows. `null` = not loaded
     yet, distinct from "loaded and empty". */
  const [cloudTrips, setCloudTrips] = useState<Trip[] | null>(null);

  const loadRentalHistory = useCallback(async () => {
    if (!user) return;
    const { data, error } = await supabase
      .from('rentals')
      .select('id, wheelchair_id, state, start_at, end_at, duration_s, created_at')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error || !data) return; // keep showing what we have rather than blanking
    const nowMs = serverNow();
    const rows = data as {
      id: string; wheelchair_id: string; state: string;
      start_at: string | null; end_at: string | null;
      duration_s: number | null; created_at: string;
    }[];
    const finished = rows.filter(
      (r) => r.state === 'ended' || (r.end_at != null && Date.parse(r.end_at) < nowMs),
    );
    setCloudTrips(
      finished.map((r) => {
        const startMs = Date.parse(r.start_at ?? r.created_at);
        const endMs = r.end_at ? Date.parse(r.end_at) : startMs + (r.duration_s ?? 0) * 1000;
        const seconds = Math.max(0, Math.round((endMs - startMs) / 1000));
        return { id: r.id, at: startMs, chairId: r.wheelchair_id, seconds, meters: 0, fee: estimateFee(seconds) };
      }),
    );
  }, [user]);

  useEffect(() => {
    if (user) void loadRentalHistory();
    else setCloudTrips(null);
  }, [user, loadRentalHistory]);

  /* What the rider actually sees. The server list is the account's truth; the
     device record only contributes the GPS-measured distance, which the server
     does not store. With no server answer yet (or none ever — rides taken
     before accounts existed) the device record still shows. */
  const accountTrips = useMemo<Trip[]>(() => {
    if (!cloudTrips) return trips;
    if (!cloudTrips.length && trips.length) return trips;
    return cloudTrips.map((ct) => {
      const local = trips.find(
        (t) => t.chairId === ct.chairId && Math.abs(t.at - ct.at) < 10 * 60_000,
      );
      return local ? { ...ct, meters: local.meters } : ct;
    });
  }, [cloudTrips, trips]);

  // Restore this user's device-local state exactly once per signed-in user.
  const restoredFor = useRef<string | null>(null);

  /* ---------------- the signed-in user IS the session -----------------------
     Supabase restores the session from its cookie before the first render
     settles, so this is the single place the app learns who is here. The only
     onboarding state comes from the profile row, so it follows the account
     rather than the browser. */
  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      restoredFor.current = null;
      setSession(null);
      setScreen('login');
      return;
    }
    // Wait for the profile before choosing a screen. `user` arrives first and
    // the ROLE arrives with the profile, so deciding here early meant an
    // operator was briefly handed the rider intro before the /ops redirect
    // caught up — the "Ready to ride?" flash. Waiting costs one render and
    // removes the whole class of bug.
    if (!profileLoaded) return;

    setSession({
      id: user.id,
      email: user.email ?? '',
      name: displayName || nameFromEmail(user.email ?? ''),
      onboarded,
    });

    // Depot staff get no rider screen at all — not the intro, not the map.
    // The effect below sends them to /ops; until it does, the splash renders.
    if (isOperator) return;

    setScreen(onboarded ? 'app' : 'ready');

    // Guarded by uid, not by effect identity: this effect re-runs when the
    // display name loads or changes, and re-restoring then would clobber a
    // ride in progress.
    if (restoredFor.current !== user.id) {
      restoredFor.current = user.id;
      try {
        const rawTrips = localStorage.getItem(`${TRIPS_KEY}:${user.id}`);
        const parsedTrips = rawTrips ? (JSON.parse(rawTrips) as Trip[]) : [];
        setTrips(Array.isArray(parsedTrips) ? parsedTrips.slice(0, 40) : []);

        const rawRide = localStorage.getItem(`${RIDE_KEY}:${user.id}`);
        const parsed = rawRide ? (JSON.parse(rawRide) as Partial<Ride>) : null;
        if (parsed && typeof parsed.chairId === 'string' && typeof parsed.startedAt === 'number') {
          setRide({ chairId: parsed.chairId, startedAt: parsed.startedAt });
          setChosenId(parsed.chairId);
        } else {
          setRide(null);
        }
      } catch {
        setTrips([]);
      }
    }
  }, [user, displayName, authLoading, profileLoaded, onboarded, isOperator]);

  // Depot staff signing in here belong in the console, not the rider app —
  // unless they are mid password reset, which must finish first.
  useEffect(() => {
    if (!authLoading && user && isOperator && !recovering && !recoveryParam) router.replace('/ops');
  }, [authLoading, user, isOperator, recovering, recoveryParam, router]);

  // The reset link lands via /auth/callback, which redirects here with a
  // marker. Read it once and strip it, so a refresh does not re-trigger.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('recovery') === '1') {
      setRecoveryParam(true);
      window.history.replaceState({}, '', window.location.pathname);
    }
    const err = params.get('authError');
    if (err) {
      setAuthError(err);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  useEffect(() => {
    if (!booted || !session) return;
    try {
      if (ride) localStorage.setItem(`${RIDE_KEY}:${session.id}`, JSON.stringify(ride));
      else localStorage.removeItem(`${RIDE_KEY}:${session.id}`);
    } catch {
      /* ignore */
    }
  }, [ride, booted, session]);

  /* ---------------- derived live state -------------------------------------- */
  const byId = useMemo(() => {
    const m = new Map<string, DeviceState>();
    for (const d of deviceStates) m.set(d.wheelchair_id, d);
    return m;
  }, [deviceStates]);

  // Service areas come from the operator's live geofence zones in Supabase.
  // Combines operator-created zones and default sites so new geofences appear live.
  const sites = useMemo<Site[]>(() => {
    const custom: Site[] = zones
      .filter((z) => (z as { active?: boolean }).active !== false)
      .map((z) => ({
        key: z.id,
        label: z.name,
        short: (z.name.split('—')[0] ?? z.name).trim() || z.name,
        lat: z.center_lat,
        lng: z.center_lng,
      }));

    if (!custom.length) return SITES;

    const combined = [...custom];
    for (const s of SITES) {
      if (!combined.some((c) => c.key === s.key || c.label.toLowerCase() === s.label.toLowerCase())) {
        combined.push(s);
      }
    }
    return combined;
  }, [zones]);

  const site = useMemo(() => sites.find((s) => s.key === siteKey) ?? sites[0], [sites, siteKey]);

  // Once zones load, the initial siteKey (a SITES constant) no longer exists —
  // adopt the nearest real area instead of silently falling back to sites[0].
  useEffect(() => {
    if (!sites.length) return;
    if (sites.some((s) => s.key === siteKey)) return;
    const here = geo;
    const next = here ? nearestSite(here[0], here[1], sites).site : sites[0];
    setSiteKey(next.key);
  }, [sites, siteKey, geo]);

  // Chairs near the chosen site. Real hardware may sit nowhere near a seeded
  // site, so fall back to the whole fleet rather than showing an empty map.
  const visible = useMemo(() => {
    const inSite = deviceStates.filter((d) => siteKeyOf(d, sites) === siteKey);
    return inSite.length ? inSite : deviceStates;
  }, [deviceStates, siteKey, sites]);

  const origin: [number, number] = useMemo(
    () => geo ?? [site.lat, site.lng],
    [geo, site],
  );

  // Positions run through the smoother so losing or regaining a satellite fix
  // reads as ordinary movement. The rider is never told which is which —
  // they just see their chair where it plausibly is. A chair absent from this
  // map has no trustworthy position at all.
  // The smoother carries per-chair blend state, so resolving must happen in an
  // effect rather than in render: a render that React discards or replays
  // would otherwise advance the blend twice for one tick and make the
  // GPS<->estimated hand-over jump.
  const smootherRef = useRef(new PositionSmoother());
  const [positions, setPositions] = useState<Map<string, ResolvedPosition>>(() => new Map());
  // Positions land one commit after the fleet does. Without this flag the
  // "no chairs nearby" empty state flashes for a frame between the fleet
  // arriving and its positions being resolved.
  const [positionsReady, setPositionsReady] = useState(false);

  useEffect(() => {
    const out = new Map<string, ResolvedPosition>();
    for (const d of visible) {
      const p = smootherRef.current.resolve(d, isOnline(d, now), now);
      if (p) out.set(d.wheelchair_id, p);
    }
    setPositions(out);
    setPositionsReady(true);
  }, [visible, now]);

  // Recommendation = nearest, plainly. isRentable() already drops anything under
  // 25% battery, offline (no telemetry within 30s), or not reported available
  // by the device. `now` in the deps keeps availability live: a chair that
  // stops reporting falls off this list within seconds.
  const nearby = useMemo(() => {
    return visible
      .filter((d) => isRentable(d, now))
      // "Nearest" is meaningless for a chair whose position is unknown, and
      // sending a rider toward a guess is worse than not listing it.
      .filter((d) => positions.has(d.wheelchair_id))
      .map((d) => {
        const p = positions.get(d.wheelchair_id);
        const at: [number, number] | null = p ? [p.lat, p.lng] : null;
        return { d, m: at ? distanceM(at, origin) : Number.POSITIVE_INFINITY };
      })
      .sort((a, b) => a.m - b.m)
      .slice(0, 8);
  }, [visible, origin, now, positions]);

  const resolvedPos = useCallback(
    (d: DeviceState | null | undefined): [number, number] | null => {
      if (!d) return null;
      const p = positions.get(d.wheelchair_id);
      if (p) return [p.lat, p.lng];
      return posOf(d);
    },
    [positions],
  );

  const chosen = chosenId ? byId.get(chosenId) ?? null : null;
  const previewFromId = previewId ? byId.get(previewId) ?? null : null;
  const preview = chosen ?? previewFromId ?? (nearby[0] ? nearby[0].d : null);
  const previewPos = resolvedPos(preview);
  const previewMetres = previewPos ? distanceM(previewPos, origin) : null;

  const rideChair = ride ? byId.get(ride.chairId) ?? null : null;
  const rideChairPos = resolvedPos(rideChair);

  const fenceSource = rideChair ?? preview ?? visible.find((d) => d.geofence?.on) ?? null;
  const fence = useMemo(() => fencePolygon(fenceSource), [fenceSource]);
  // Only assert a breach from LIVE telemetry — warning a rider they have left
  // the allowed area based on a stale frame would be both wrong and alarming.
  const breach = Boolean(
    rideChair
    && isOnline(rideChair, now)
    && rideChair.geofence?.on
    && rideChair.geofence?.in === 0,
  );

  const units: MapUnit[] = useMemo(() => {
    // Drop any chair we cannot actually locate (online but no real fix yet in
    // this power cycle) rather than pinning it to a guess.
    const placed = (u: MapUnit): MapUnit | null => {
      const p = positions.get(u.id);
      return p ? { ...u, lat: p.lat, lng: p.lng } : null;
    };
    const keep = (list: MapUnit[]) => list.map(placed).filter((u): u is MapUnit => u !== null);
    if (ride) {
      const d = rideChair;
      return d ? keep(toUnits([d], now)) : [];
    }
    const list = visible.filter(
      (d) => isRentable(d, now) || d.wheelchair_id === previewId || d.wheelchair_id === chosenId,
    );
    return keep(toUnits(list.slice(0, 30), now));
  }, [ride, rideChair, visible, previewId, chosenId, now, positions]);

  // Keyed on the numbers, not the tuples: rideChairPos/previewPos are rebuilt
  // every render, so using them directly gave mapState a new dependency
  // identity each pass and defeated its memoisation entirely.
  const centerLat = rideChairPos?.[0] ?? geo?.[0] ?? previewPos?.[0] ?? site.lat;
  const centerLng = rideChairPos?.[1] ?? geo?.[1] ?? previewPos?.[1] ?? site.lng;
  const mapCenter = useMemo<[number, number]>(
    () => [centerLat, centerLng],
    [centerLat, centerLng],
  );

  // The same named service areas the operator drew. Read-only here — riders
  // see where they may ride, with no controls and no jargon.
  const mapZones = useMemo<MapZone[]>(
    () =>
      zones
        .filter((z) => z.active)
        .map((z) => ({
          id: z.id,
          name: z.name,
          lat: z.center_lat,
          lng: z.center_lng,
          radiusM: z.radius_m,
          color: z.color,
        })),
    [zones],
  );

  const mapState: MapState = useMemo(
    () => ({
      center: mapCenter,
      zoom: ride ? Math.max(zoom, 18) : zoom,
      units,
      fence,
      zones: mapZones,
      breach,
      activeId: chosenId ?? previewId ?? (preview ? preview.wheelchair_id : null),
      me: geo,
      theme,
      markerStyle: ride ? 'arrow' : 'pin',
      follow: Boolean(ride),
      fit,
      recenter,
      trail: ride ? trail : [],
    }),
    [
      mapCenter,
      ride,
      zoom,
      units,
      fence,
      mapZones,
      breach,
      chosenId,
      previewId,
      preview,
      geo,
      theme,
      fit,
      recenter,
      trail,
    ],
  );

  /* ---------------- clock + trail ------------------------------------------- */
  // Always ticking (not just during a ride): online/offline is derived from
  // telemetry freshness, so the availability lists must re-evaluate as time
  // passes even when no new rows arrive.
  useEffect(() => {
    setNow(serverNow());
    const t = setInterval(() => setNow(serverNow()), 1000);
    return () => clearInterval(t);
  }, [ride]);

  useEffect(() => {
    if (!ride || !rideChairPos) return;
    const p = rideChairPos;
    setTrail((prev) => {
      const last = prev[prev.length - 1];
      if (last && distanceM(last, p) < 3) return prev;
      const next = [...prev, p];
      return next.length > 500 ? next.slice(next.length - 500) : next;
    });
    // rideChairPos is a fresh tuple per telemetry frame; the <3 m guard stops the loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ride, rideChairPos ? rideChairPos[0] : null, rideChairPos ? rideChairPos[1] : null]);

  const rideSeconds = ride ? Math.max(0, Math.floor((now - ride.startedAt) / 1000)) : 0;
  const rideMetres = useMemo(() => trailLength(trail), [trail]);
  const liveFee = estimateFee(rideSeconds);

  const closeRide = useCallback(
    (note?: string) => {
      setRide((current) => {
        if (!current) return null;
        const seconds = Math.max(0, Math.floor((serverNow() - current.startedAt) / 1000));
        const trip: Trip = {
          id: makeId(),
          at: Date.now(),
          chairId: current.chairId,
          seconds,
          meters: rideMetres,
          fee: estimateFee(seconds),
        };
        setReceipt(trip);
        setTrips((prev) => {
          const next = [trip, ...prev].slice(0, 40);
          try {
            if (uid) localStorage.setItem(`${TRIPS_KEY}:${uid}`, JSON.stringify(next));
          } catch {
            /* ignore */
          }
          return next;
        });
        return null;
      });
      setTrail([]);
      setChosenId(null);
      setEnding(false);
      setRiderError('');
      setTab('map');
      // The server closed the rental; pull the account's history so the trip
      // shows up on every signed-in device, not just this one.
      void loadRentalHistory();
      if (note) say(note);
    },
    [rideMetres, say, uid, loadRentalHistory],
  );

  // The device is the authority: if the chair closes its own session (expiry,
  // fault, depot action) the ride ends here too.
  useEffect(() => {
    if (!ride || !rideChair) return;
    if (serverNow() - ride.startedAt < 12000) return;
    const closed = rideChair.locked === true && rideChair.session_state === 'LOCKED';
    if (closed) closeRide('The chair locked itself — the ride is closed.');
  }, [ride, rideChair, closeRide]);

  /* ---------------- device polling helpers ---------------------------------- */
  const pollDevice = useCallback(
    async (id: string, want: (d: Pick<DeviceState, 'locked'>) => boolean, timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const live = statesRef.current.find((d) => d.wheelchair_id === id);
        if (live && want(live)) return true;
        await sleep(500);
        const { data } = await supabase
          .from('device_state')
          .select('locked')
          .eq('wheelchair_id', id)
          .maybeSingle();
        const row = data as { locked: boolean } | null;
        if (row && want(row)) return true;
      }
      return false;
    },
    [],
  );

  /* ---------------- unlock (rental → payment → device ack) ------------------ */
  const doUnlock = useCallback(async () => {
    if (busyRef.current) return;
    const id = chosenId;
    const chair = id ? byId.get(id) : null;
    if (!id || !chair) {
      setRiderError('Scan the code on the chair before unlocking it.');
      return;
    }
    if (!isRentable(chair)) {
      setRiderError(
        `Chair ${shortId(id)} is ${STATUS_META[statusOf(chair)].label.toLowerCase()} right now. Pick another one.`,
      );
      return;
    }

    busyRef.current = true;
    setRiderError('');
    setUnlockStage('creating');
    let rentalId: string | null = null;

    try {
      const created = await fetch('/api/rentals/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wheelchair_id: id, duration_s: RIDE_DURATION_S }),
      });
      const createdJson = await readJson<RentalCreateResponse>(created);
      if (!created.ok || !createdJson?.rental?.id) {
        setRiderError(createdJson?.error ?? 'The depot could not open a rental for this chair.');
        setUnlockStage('idle');
        return;
      }
      rentalId = createdJson.rental.id;

      setUnlockStage('paying');
      const paid = await fetch('/api/payments/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'mock',
          rental_id: rentalId,
          amount: Math.round(UNLOCK_FEE * 100),
          provider_ref: `ZM2-${Date.now()}`,
        }),
      });
      const paidJson = await readJson<WebhookResponse>(paid);
      if (!paid.ok) {
        // Release the reservation we just made so a failed payment cannot
        // strand the chair behind a dead 'reserved' row. Runs server-side —
        // the live rentals table is read-only for browser clients.
        await fetch('/api/rentals/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rental_id: rentalId }),
        }).catch(() => {});
        setRiderError(paidJson?.error ?? 'Payment did not go through. Nothing was charged.');
        setUnlockStage('idle');
        return;
      }

      // The webhook enqueues the real UNLOCK command. Nothing is true until the
      // chair itself reports that it is open.
      setUnlockStage('waiting');
      const opened = await pollDevice(id, (d) => d.locked === false, DEVICE_WAIT_MS);
      if (!opened) {
        setRiderError(
          `Chair ${shortId(id)} has not reported that it opened. Do not force it — pick another chair or call the depot.`,
        );
        setUnlockStage('idle');
        return;
      }

      const startedAt = serverNow();
      setRide({ chairId: id, startedAt });
      setTrail([]);
      setNow(startedAt);
      setUnlockStage('idle');
      setZoom(18);
      setRecenter(Date.now());
      say('Unlocked. Enjoy your ride.');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setRiderError(`Could not reach the depot: ${message}`);
      setUnlockStage('idle');
    } finally {
      busyRef.current = false;
    }
  }, [chosenId, byId, pollDevice, say]);

  /* ---------------- end the ride (two-signal stop check) -------------------- */
  // The stop signals are only trustworthy while telemetry is FRESH. A chair
  // that went offline mid-ride must refuse the check — its last speed/motion
  // report may be seconds or minutes old.
  const rideChairOnline = Boolean(rideChair && isOnline(rideChair, now));
  // isStationary() combines the two independent signals and returns null when
  // neither can answer — we refuse to end the ride on an assumption.
  const safeToEnd = Boolean(rideChairOnline && isStationary(rideChair) === true);

  const doEndRide = useCallback(async () => {
    if (busyRef.current || !ride) return;
    const chair = byId.get(ride.chairId) ?? null;
    if (!chair || !isOnline(chair)) {
      setRiderError('The chair is offline — it is not reporting right now. Wait for it to reconnect and hold again.');
      return;
    }
    // HANDOFF two-signal interlock. Indoors there is no GPS speed to read, so
    // the IMU carries the check; outdoors both must agree. If neither signal
    // is available we refuse rather than guess that it has stopped.
    const stationary = isStationary(chair);
    if (stationary === null) {
      setRiderError('The chair cannot confirm it has stopped. Wait a moment and hold again.');
      return;
    }
    if (!stationary) {
      setRiderError('The chair is still moving — come to a full stop.');
      say('Come to a full stop before ending the ride');
      return;
    }

    busyRef.current = true;
    setEnding(true);
    setRiderError('');
    try {
      const lock = await sendCommand(ride.chairId, 'LOCK');
      if (!lock.ok) {
        setRiderError(lock.message ?? 'The chair did not confirm the lock. The ride is still open.');
        setEnding(false);
        return;
      }
      const end = await sendCommand(ride.chairId, 'END_SESSION');
      const locked = await pollDevice(ride.chairId, (d) => d.locked === true, DEVICE_WAIT_MS);
      if (!locked && !end.ok) {
        setRiderError(
          end.message ?? 'The chair has not confirmed it is locked. The ride stays open — call the depot.',
        );
        setEnding(false);
        return;
      }
      closeRide();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setRiderError(`Could not end the ride: ${message}`);
      setEnding(false);
    } finally {
      busyRef.current = false;
    }
  }, [ride, byId, pollDevice, closeRide, say]);

  const ringChair = useCallback(async () => {
    if (!ride || ringing) return;
    setRinging(true);
    const res = await sendCommand(ride.chairId, 'PING');
    setRinging(false);
    say(res.ok ? 'The chair answered — listen for the beep' : res.message ?? 'The chair did not answer.');
  }, [ride, ringing, say]);

  /* ---------------- fall / emergency ---------------------------------------
     Device-asserted only: the ESP32 latches its own fall interlock, cuts the
     relay and sounds the siren, then reports SAFE_FAULT. We render that — we
     never decide it here. Tilt is shown as corroborating detail. */
  const emergency = Boolean(
    rideChair && rideChairOnline && rideChair.session_state === 'SAFE_FAULT',
  );
  const emergencyIsFall = Boolean(
    rideChair && (rideChair.tilt ?? 0) > FALL_TILT_DEG,
  );

  const clearEmergency = useCallback(async () => {
    if (!ride || clearingEmergency) return;
    setClearingEmergency(true);
    setRiderError('');
    const res = await sendCommand(ride.chairId, 'CLEAR_SOS');
    setClearingEmergency(false);
    if (!res.ok) {
      setRiderError(
        res.message ?? 'The chair would not clear its alarm. If it is still tipped over, stand it upright first.',
      );
      return;
    }
    say('Alarm cleared — the chair has stood down');
  }, [ride, clearingEmergency, say]);

  const unlockHold = useHold(UNLOCK_HOLD_MS, doUnlock);
  const endHold = useHold(END_HOLD_MS, doEndRide);

  /* ---------------- geolocation --------------------------------------------- */
  const handlePosition = useCallback(
    (pos: GeolocationPosition, manual: boolean) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const { site: closest, metres } = nearestSite(lat, lng, sites);
      const far = metres > SITE_RADIUS_M;

      setGeoState('granted');
      setGeo([lat, lng]);
      if (!far) setSiteKey(closest.key);

      if (manual) {
        setRecenter(Date.now());
        say('Live location updated — showing nearest wheelchairs');
      }
    },
    [sites, say],
  );

  const askLocation = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGeoState('unavailable');
      setGeoNote('This browser cannot share your location.');
      return;
    }
    setGeoState('asking');
    navigator.geolocation.getCurrentPosition(
      (pos) => handlePosition(pos, true),
      () => {
        setGeoState('denied');
        setGeoNote(`Location is off, so distances are measured from ${site.label}.`);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 },
    );
  }, [handlePosition, site, say]);

  // Live Location Tracking: watch position changes continuously
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return;

    // Initial silent request on load
    navigator.geolocation.getCurrentPosition(
      (pos) => handlePosition(pos, false),
      () => {},
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 10000 },
    );

    const watchId = navigator.geolocation.watchPosition(
      (pos) => handlePosition(pos, false),
      () => {},
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 },
    );

    return () => {
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
    };
  }, [handlePosition]);

  /* ---------------- scanner -------------------------------------------------- */
  const stopCamera = useCallback(() => {
    const stream = streamRef.current;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    const v = videoRef.current;
    if (v) v.srcObject = null;
  }, []);

  const requestCamera = useCallback(async () => {
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!md || typeof md.getUserMedia !== 'function') {
      setCam('denied');
      setManualOpen(true);
      return;
    }
    try {
      const stream = await md.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      streamRef.current = stream;
      setCam('live');
      const v = videoRef.current;
      if (v) {
        v.srcObject = stream;
        const p = v.play();
        if (p) p.catch(() => undefined);
      }
    } catch {
      setCam('denied');
      setManualOpen(true);
    }
  }, []);

  const closeScanner = useCallback(() => {
    stopCamera();
    if (scanTimer.current) {
      clearTimeout(scanTimer.current);
      scanTimer.current = null;
    }
    setScanOpen(false);
    setCam('prompt');
    setManualOpen(false);
  }, [stopCamera]);

  const openScanner = useCallback(() => {
    setRiderError('');
    setManualOpen(false);
    setCam('prompt');
    setScanOpen(true);
  }, []);

  useEffect(() => {
    if (!scanOpen) return;
    const t = setTimeout(() => {
      void requestCamera();
    }, 260);
    return () => clearTimeout(t);
  }, [scanOpen, requestCamera]);

  // Never leave the camera running.
  useEffect(
    () => () => {
      stopCamera();
      if (toastTimer.current) clearTimeout(toastTimer.current);
      if (scanTimer.current) clearTimeout(scanTimer.current);
    },
    [stopCamera],
  );

  // A scan is the ONLY thing that selects a chair for unlocking.
  const finishScan = useCallback(
    (id: string | null) => {
      const target = id
        ? byId.get(id) ?? null
        : previewFromId && isRentable(previewFromId)
          ? previewFromId
          : nearby[0]
            ? nearby[0].d
            : null;
      if (!target) {
        setRiderError('No chair is free to scan right now.');
        return;
      }
      if (!isRentable(target)) {
        setRiderError(
          `Chair ${shortId(target.wheelchair_id)} is ${STATUS_META[statusOf(target)].label.toLowerCase()}. Try another one.`,
        );
        return;
      }
      const key = siteKeyOf(target, sites);
      setCam('done');
      setChosenId(target.wheelchair_id);
      setPreviewId(target.wheelchair_id);
      if (key) setSiteKey(key);
      setRiderError('');
      scanTimer.current = setTimeout(() => {
        stopCamera();
        setScanOpen(false);
        setCam('prompt');
        setManualOpen(false);
        setTab('map');
        setZoom(17);
        setRecenter(Date.now());
        say(`Chair ${shortId(target.wheelchair_id)} scanned — hold to unlock`);
      }, 900);
    },
    [byId, previewFromId, nearby, stopCamera, say],
  );

  const confirmCode = useCallback(() => {
    const raw = riderCode.trim().toUpperCase();
    if (!raw) {
      setRiderError('Type the number printed on the handle.');
      return;
    }
    const padded = raw.padStart(3, '0');
    const match = deviceStates.find(
      (d) => d.wheelchair_id.toUpperCase() === raw || shortId(d.wheelchair_id) === padded,
    );
    if (!match) {
      setRiderError('No chair with that code. Check the label on the handle.');
      return;
    }
    setRiderCode('');
    finishScan(match.wheelchair_id);
  }, [riderCode, deviceStates, finishScan]);

  /* ---------------- sign in / out -------------------------------------------
     Real Supabase Auth. The account lives in Postgres, the password is hashed
     by GoTrue and never touches this app, and the resulting session cookie is
     what every RLS-protected read below depends on — an unauthenticated
     browser now genuinely sees no fleet at all, rather than being shown a
     screen it was politely asked not to skip. */

  const submitAuth = useCallback(async () => {
    const addr = email.trim();
    if (!/.+@.+\..+/.test(addr)) {
      setAuthError('Enter a valid email address.');
      return;
    }

    setSigningIn(true);
    setAuthError('');
    setAuthNotice('');

    // A reset only needs the address — deliberately no password field, and no
    // hint about whether the account exists.
    if (mode === 'reset') {
      const res = await requestPasswordReset(addr);
      setSigningIn(false);
      if (!res.ok) setAuthError(res.message || 'Could not send the reset link.');
      else {
        setAuthNotice(res.message || '');
        setMode('signin');
      }
      return;
    }

    if (mode === 'signup') {
      const problem = passwordProblem(pass, addr);
      if (problem) {
        setSigningIn(false);
        setAuthError(problem);
        return;
      }
    } else if (!pass) {
      setSigningIn(false);
      setAuthError('Enter your password.');
      return;
    }

    const res = mode === 'signup' ? await signUp(addr, pass, newName) : await signInAuth(addr, pass);

    setSigningIn(false);
    if (!res.ok) {
      setAuthError(res.message || 'Could not sign you in.');
      return;
    }
    if (res.needsConfirmation) {
      setAuthNotice(`Account created. Confirm ${addr} from your inbox, then sign in.`);
      setAwaitingConfirm(addr);
      setMode('signin');
      setPass('');
      return;
    }
    // On success the auth listener flips `user`, and the effect below moves
    // the app off the login screen. Nothing to do here.
    setPass('');
  }, [email, pass, mode, newName, signUp, signInAuth, requestPasswordReset]);

  const submitNewPassword = useCallback(async () => {
    setSigningIn(true);
    setAuthError('');
    const res = await updatePassword(pass);
    setSigningIn(false);
    if (!res.ok) {
      setAuthError(res.message || 'Could not update the password.');
      return;
    }
    setPass('');
    setRecoveryParam(false);
    setAuthNotice('Password updated. You are signed in.');
  }, [pass, updatePassword]);

  const doResend = useCallback(async () => {
    const res = await resendConfirmation(awaitingConfirm || email);
    if (res.ok) setAuthNotice(res.message || 'Another link is on its way.');
    else setAuthError(res.message || 'Could not resend the link.');
  }, [awaitingConfirm, email, resendConfirmation]);

  const startGoogle = useCallback(async () => {
    setAuthError('');
    setSigningIn(true);
    const res = await signInWithGoogle();
    if (!res.ok) {
      setSigningIn(false);
      setAuthError(res.message || 'Google sign-in is unavailable.');
    }
    // On success the browser navigates to Google; /auth/callback finishes it.
  }, [signInWithGoogle]);

  const resetAppState = useCallback(() => {
    setPass('');
    setAccountOpen(false);
    setRide(null);
    setChosenId(null);
    setPreviewId(null);
    setReceipt(null);
    setTrips([]);
    setCloudTrips(null);
    setTab('map');
    setPwOpen(false);
    setDeleteOpen(false);
    setPortalMsg('');
    setPortalErr('');
    // `session` and `screen` are driven by the auth effect below.
  }, []);

  const signOut = useCallback(() => {
    void authSignOut();
    resetAppState();
  }, [authSignOut, resetAppState]);

  /* ---------------- account portal actions ---------------------------------- */

  // Seed the editable fields each time the portal opens, from the freshest
  // profile we hold — not while typing, or the fetch would fight the keyboard.
  useEffect(() => {
    if (!accountOpen) return;
    setEditName(profile?.name ?? session?.name ?? '');
    setEditPhone(profile?.phone ?? '');
    setPortalMsg('');
    setPortalErr('');
    setPwOpen(false);
    setNewPw('');
    setDeleteOpen(false);
  }, [accountOpen, profile, session]);

  const saveProfile = useCallback(async () => {
    setSavingProfile(true);
    setPortalErr('');
    setPortalMsg('');
    const res = await updateProfile({ name: editName, phone: editPhone });
    setSavingProfile(false);
    if (!res.ok) {
      setPortalErr(res.message || 'Could not save your details.');
      return;
    }
    setPortalMsg('Saved.');
    const clean = editName.trim();
    if (clean) setSession((prev) => (prev ? { ...prev, name: clean } : prev));
  }, [editName, editPhone, updateProfile]);

  const savePassword = useCallback(async () => {
    setSavingPw(true);
    setPortalErr('');
    setPortalMsg('');
    const res = await updatePassword(newPw);
    setSavingPw(false);
    if (!res.ok) {
      setPortalErr(res.message || 'Could not update the password.');
      return;
    }
    setNewPw('');
    setPwOpen(false);
    setPortalMsg('Password updated.');
  }, [newPw, updatePassword]);

  const pickAvatar = useCallback(async (file: File | null | undefined) => {
    if (!file) return;
    setUploadingAvatar(true);
    setPortalErr('');
    setPortalMsg('');
    const res = await uploadAvatar(file);
    setUploadingAvatar(false);
    if (!res.ok) setPortalErr(res.message || 'Could not upload the photo.');
    else setPortalMsg(res.message || 'Photo updated.');
    if (avatarInputRef.current) avatarInputRef.current.value = '';
  }, [uploadAvatar]);

  // Settings write straight through to the profile row — no local mirror to
  // fall out of step with the server.
  const setSetting = useCallback(
    async (fields: Parameters<typeof updateProfile>[0]) => {
      setPortalErr('');
      const res = await updateProfile(fields);
      if (!res.ok) setPortalErr(res.message || 'Could not save that setting.');
    },
    [updateProfile],
  );

  const toggleLanguage = useCallback(() => {
    void setSetting({ locale: profile?.locale === 'ar' ? 'en' : 'ar' });
  }, [profile, setSetting]);

  const signOutAllDevices = useCallback(() => {
    void signOutEverywhere();
    resetAppState();
  }, [signOutEverywhere, resetAppState]);

  const deleteAccount = useCallback(async () => {
    setDeleting(true);
    setPortalErr('');
    const res = await fetch('/api/account/delete', { method: 'POST' });
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    setDeleting(false);
    if (!res.ok) {
      setPortalErr(body?.error || 'Could not delete the account.');
      return;
    }
    // The account is gone server-side; leave nothing of it on this device.
    if (uid) {
      try {
        localStorage.removeItem(`${TRIPS_KEY}:${uid}`);
        localStorage.removeItem(`${RIDE_KEY}:${uid}`);
        localStorage.removeItem(`${ONBOARDED_KEY}:${uid}`);
      } catch {
        /* ignore */
      }
    }
    void authSignOut();
    resetAppState();
  }, [uid, authSignOut, resetAppState]);

  const goMap = useCallback(() => {
    // Recorded against the account, so the intro does not reappear on the
    // rider's next phone, in a private window, or after clearing site data.
    void markOnboarded();
    setSession((prev) => (prev ? { ...prev, onboarded: true } : prev));
    setScreen('app');
    setTab('map');
    if (geoState === 'prompt') setTimeout(() => askLocation(), 500);
  }, [geoState, askLocation, markOnboarded]);

  /* ---------------- pin taps only locate ------------------------------------ */
  const onPickUnit = useCallback(
    (id: string) => {
      const d = byId.get(id);
      if (!d) return;
      setPreviewId(id);
      setRiderError('');
      setZoom(18);
      setRecenter(Date.now());
      const key = siteKeyOf(d, sites);
      if (key) setSiteKey(key);
      say(
        isRentable(d)
          ? `Chair ${shortId(id)} located — walk over and scan its code`
          : `Chair ${shortId(id)} is ${STATUS_META[statusOf(d)].label.toLowerCase()}`,
      );
    },
    [byId, say],
  );

  /* ---------------- back --------------------------------------------------- */
  const canGoBack = tab === 'map' && (Boolean(chosenId) || Boolean(previewId)) && !ride;
  const goBack = useCallback(() => {
    setChosenId(null);
    setPreviewId(null);
    setRiderError('');
  }, []);

  /* ---------------- shared style fragments ---------------------------------- */
  const sheetStyle: CSSProperties = {
    position: 'fixed',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 700,
    background: 'var(--card-bg)',
    color: 'var(--ink)',
    borderRadius: '30px 30px 0 0',
    padding: '5px 14px calc(74px + env(safe-area-inset-bottom))',
    boxShadow: '0 -8px 26px rgba(10,12,20,.22)',
  };
  const headingStyle: CSSProperties = {
    fontFamily: 'var(--font-heading)',
    fontWeight: 800,
    letterSpacing: '-.02em',
  };
  const floatBtn: CSSProperties = {
    pointerEvents: 'auto',
    flex: 'none',
    width: 44,
    height: 44,
    border: '1px solid var(--hair)',
    borderRadius: 999,
    background: 'var(--float-bg)',
    color: 'var(--ink)',
    display: 'grid',
    placeItems: 'center',
    cursor: 'pointer',
    boxShadow: '0 6px 18px rgba(10,12,20,.22)',
  };
  const tabPage: CSSProperties = {
    padding: '22px 20px 120px',
    maxWidth: 760,
    margin: '0 auto',
  };
  const cardRow: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 14,
    padding: 18,
    border: 0,
    borderRadius: 20,
    background: 'var(--card-bg)',
    color: 'var(--ink)',
    cursor: 'pointer',
    textAlign: 'left',
    width: '100%',
  };

  const cityLabel = site.label;
  const freeHere = useMemo(() => {
    const counts = new Map<string, number>();
    for (const d of deviceStates) {
      if (!isRentable(d)) continue;
      const key = siteKeyOf(d, sites);
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
    // `sites` is a dependency: the counts are keyed by zone id, so they must
    // be rebuilt whenever the operator's zone list changes.
  }, [deviceStates, sites]);

  const totalSpend = accountTrips.reduce((n, t) => n + t.fee, 0);

  /* ---------------- splash ---------------------------------------------------
     Also covers the two windows where the app knows a user but not yet what to
     do with them: the profile (and therefore the role) still loading, and an
     operator on their way to /ops. Rendering rider UI in either window is what
     flashed "Ready to ride?" at depot staff. */
  if (!booted || (user && !profileLoaded) || (user && isOperator)) {
    return (
      <main
        style={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          background: 'var(--app-bg)',
          color: 'var(--ink)',
        }}
      >
        <span style={{ fontFamily: 'var(--font-heading)', fontSize: 30, letterSpacing: '-.03em' }}>
          <span style={{ fontWeight: 500 }}>zetta</span>
          <span style={{ fontWeight: 800 }}>might</span>
        </span>
      </main>
    );
  }

  /* ================================================================== *
   * Render
   * ================================================================== */
  return (
    <div
      style={{
        minHeight: '100vh',
        overflowX: 'hidden',
        background: 'var(--app-bg)',
        color: 'var(--ink)',
        transition: 'background .3s ease',
      }}
    >
      {/* keyframes the shared stylesheet does not carry */}
      <style>{`@keyframes zm-sweep{0%,100%{top:8%}50%{top:90%}}`}</style>

      {/* ---------------- 00a Set a new password ----------------
          Takes precedence over every other screen. A reset link creates a
          real session, so without this the rider would simply be signed in
          and never asked for the password they came here to change. */}
      {(recovering || recoveryParam) && (
        <section
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 200,
            background: 'var(--login-bg)',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            padding: '30px 24px',
            gap: 18,
          }}
        >
          <span style={{ fontFamily: 'var(--font-heading)', fontSize: 30, letterSpacing: '-.03em', color: 'var(--ink)' }}>
            <span style={{ fontWeight: 500 }}>zetta</span>
            <span style={{ fontWeight: 800 }}>might</span>
          </span>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: 'var(--ink)' }}>Choose a new password</h1>
            <p style={{ margin: '6px 0 0', fontSize: 14, color: 'var(--muted)', lineHeight: 1.5 }}>
              {user?.email ? `For ${user.email}.` : ''} At least 8 characters.
            </p>
          </div>
          <form
            style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
            onSubmit={(e) => {
              e.preventDefault();
              void submitNewPassword();
            }}
          >
            <input
              type="password"
              value={pass}
              onChange={(e) => {
                setPass(e.target.value);
                setAuthError('');
              }}
              placeholder="New password"
              autoComplete="new-password"
              autoFocus
              style={{
                minHeight: 56,
                borderRadius: 16,
                border: '1px solid var(--hair)',
                background: 'var(--card-bg)',
                color: 'var(--ink)',
                padding: '0 18px',
                fontSize: 16,
              }}
            />
            <PasswordMeter password={pass} />
            {authError && (
              <span role="alert" style={{ fontSize: 13, color: 'var(--accent-600)' }}>{authError}</span>
            )}
            <button
              type="submit"
              disabled={signingIn}
              style={{
                minHeight: 60,
                border: 0,
                borderRadius: 999,
                background: 'var(--ink)',
                color: 'var(--app-bg)',
                fontSize: 17,
                fontWeight: 700,
                cursor: signingIn ? 'progress' : 'pointer',
              }}
            >
              {signingIn ? 'Saving…' : 'Save new password'}
            </button>
          </form>
        </section>
      )}

      {/* ---------------- 00 Welcome / sign in ---------------- */}
      {screen === 'login' && (
        <section
          style={{
            minHeight: '100vh',
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--login-bg)',
          }}
        >
          <div
            style={{
              flex: 1,
              minHeight: '40vh',
              position: 'relative',
              overflow: 'hidden',
              background: 'var(--login-art)',
            }}
          >
            <Image
              src="/login.gif"
              alt="A rider moving through the city in a powered wheelchair"
              fill
              unoptimized
              priority
              sizes="100vw"
              style={{ objectFit: 'cover', objectPosition: 'center 42%' }}
            />
            <span
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: 0,
                height: '34%',
                background: 'linear-gradient(to bottom, rgba(0,0,0,0), var(--login-bg))',
              }}
            />
          </div>

          <div style={{ padding: '30px 24px 34px', display: 'flex', flexDirection: 'column', gap: 22 }}>
            <div className="rise" style={{ display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap' }}>
              <span
                style={{
                  fontFamily: 'var(--font-heading)',
                  fontSize: 40,
                  letterSpacing: '-.03em',
                  lineHeight: 0.9,
                  color: 'var(--ink)',
                }}
              >
                <span style={{ fontWeight: 500 }}>zetta</span>
                <span style={{ fontWeight: 800 }}>might</span>
              </span>
              <span style={{ fontSize: 17, lineHeight: 1.2, color: 'var(--ink)', maxWidth: '12ch' }}>
                <span style={{ display: 'block' }}>Urban Mobility,</span>
                <span style={{ display: 'block' }}>Redefined.</span>
              </span>
            </div>

            <div className="rise2" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {/* Shown only once the project confirms Google is configured.
                  Offering it otherwise navigates the rider off-site to a raw
                  JSON error with no way back — worse than not offering it. */}
              {googleEnabled === true && (
              <button
                onClick={() => void startGoogle()}
                disabled={signingIn}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 12,
                  minHeight: 60,
                  border: '1px solid var(--hair)',
                  borderRadius: 999,
                  background: '#ffffff',
                  color: '#14161f',
                  fontSize: 17,
                  fontWeight: 700,
                  cursor: 'pointer',
                  boxShadow: '0 6px 20px rgba(20,22,31,.1)',
                }}
              >
                <span
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 999,
                    display: 'grid',
                    placeItems: 'center',
                    fontWeight: 800,
                    color: '#4285f4',
                    fontSize: 15,
                  }}
                >
                  G
                </span>
                <span>Continue with Google</span>
              </button>
              )}
              {/* With Google hidden this is the only way in, so it carries the
                  primary weight rather than reading as a quiet alternative. */}
              {!emailOpen && (
                <button
                  onClick={() => setEmailOpen(true)}
                  style={
                    googleEnabled === true
                      ? {
                          minHeight: 52,
                          border: 0,
                          background: 'transparent',
                          color: 'var(--ink)',
                          fontSize: 16,
                          fontWeight: 700,
                          cursor: 'pointer',
                        }
                      : {
                          minHeight: 60,
                          border: 0,
                          borderRadius: 999,
                          background: 'var(--ink)',
                          color: 'var(--app-bg)',
                          fontSize: 17,
                          fontWeight: 700,
                          cursor: 'pointer',
                        }
                  }
                >
                  Continue with email
                </button>
              )}
            </div>

            {emailOpen && (
              <form
                className="rise"
                style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  void submitAuth();
                }}
              >
                {mode === 'signup' && (
                  <input
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="Your name"
                    autoComplete="name"
                    style={{
                      minHeight: 56,
                      borderRadius: 16,
                      border: '1px solid var(--hair)',
                      background: 'var(--card-bg)',
                      padding: '0 18px',
                      fontSize: 16,
                    }}
                  />
                )}
                <input
                  type="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setAuthError('');
                  }}
                  placeholder="you@example.com"
                  autoComplete="email"
                  style={{
                    minHeight: 56,
                    borderRadius: 16,
                    border: '1px solid var(--hair)',
                    background: 'var(--card-bg)',
                    padding: '0 18px',
                    fontSize: 16,
                  }}
                />
                {/* A reset needs only the address — showing a password box
                    there invites people to type the one they cannot remember. */}
                {mode !== 'reset' && (
                  <input
                    type="password"
                    value={pass}
                    onChange={(e) => {
                      setPass(e.target.value);
                      setAuthError('');
                    }}
                    placeholder={mode === 'signup' ? 'Choose a password (8+ characters)' : 'Password'}
                    autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                    style={{
                      minHeight: 56,
                      borderRadius: 16,
                      border: '1px solid var(--hair)',
                      background: 'var(--card-bg)',
                      padding: '0 18px',
                      fontSize: 16,
                    }}
                  />
                )}
                {mode === 'signup' && <PasswordMeter password={pass} />}
                <button
                  type="submit"
                  disabled={signingIn}
                  style={{
                    minHeight: 60,
                    border: 0,
                    borderRadius: 999,
                    background: 'var(--ink)',
                    color: 'var(--app-bg)',
                    fontSize: 17,
                    fontWeight: 700,
                    cursor: signingIn ? 'progress' : 'pointer',
                    opacity: signingIn ? 0.75 : 1,
                  }}
                >
                  {signingIn
                    ? mode === 'signup'
                      ? 'Creating account…'
                      : mode === 'reset'
                        ? 'Sending…'
                        : 'Signing in…'
                    : mode === 'signup'
                      ? 'Create account'
                      : mode === 'reset'
                        ? 'Send reset link'
                        : 'Sign in'}
                </button>

                {mode === 'signin' && (
                  <button
                    type="button"
                    onClick={() => {
                      setMode('reset');
                      setAuthError('');
                      setAuthNotice('');
                    }}
                    style={{
                      minHeight: 40,
                      border: 0,
                      background: 'transparent',
                      color: 'var(--muted)',
                      fontSize: 13,
                      cursor: 'pointer',
                    }}
                  >
                    Forgot your password?
                  </button>
                )}
                {mode === 'reset' && (
                  <button
                    type="button"
                    onClick={() => {
                      setMode('signin');
                      setAuthError('');
                    }}
                    style={{
                      minHeight: 40,
                      border: 0,
                      background: 'transparent',
                      color: 'var(--muted)',
                      fontSize: 13,
                      cursor: 'pointer',
                    }}
                  >
                    Back to sign in
                  </button>
                )}
                {/* Only after a signup that is actually waiting on an email —
                    otherwise this is just a button that emails strangers. */}
                {awaitingConfirm && mode === 'signin' && (
                  <button
                    type="button"
                    onClick={() => void doResend()}
                    style={{
                      minHeight: 40,
                      border: 0,
                      background: 'transparent',
                      color: 'var(--muted)',
                      fontSize: 13,
                      cursor: 'pointer',
                    }}
                  >
                    Resend the confirmation email
                  </button>
                )}
                {mode !== 'reset' && (
                  <button
                    type="button"
                    onClick={() => {
                      setMode((m) => (m === 'signin' ? 'signup' : 'signin'));
                      setPass('');
                      setAuthError('');
                      setAuthNotice('');
                    }}
                    style={{
                      minHeight: 44,
                      border: 0,
                      background: 'transparent',
                      color: 'var(--ink)',
                      fontSize: 13.5,
                      fontWeight: 700,
                      cursor: 'pointer',
                    }}
                  >
                    {mode === 'signin' ? 'New here? Create an account' : 'Already have an account? Sign in'}
                  </button>
                )}
                {/* No "I am depot staff" shortcut any more: /ops is gated by
                    middleware on the operator role, so signing in with an
                    operator account is the only way through, and the callback
                    sends those accounts straight there. */}
              </form>
            )}

            {/* Outside the email form on purpose: Google sign-in can fail too,
                and when it did the message was being set but never rendered
                because this block used to live inside the collapsed form. */}
            {authError && (
              <span role="alert" style={{ fontSize: 13, color: 'var(--accent-600)', lineHeight: 1.45 }}>
                {authError}
              </span>
            )}
            {authNotice && (
              <span role="status" style={{ fontSize: 13, color: 'var(--ink)', lineHeight: 1.45 }}>
                {authNotice}
              </span>
            )}

            <p
              style={{
                margin: 0,
                fontSize: 12.5,
                lineHeight: 1.55,
                color: 'var(--muted)',
                textAlign: 'center',
              }}
            >
              By continuing you agree to the Zettamight <a href="#terms">Terms</a> and{' '}
              <a href="#privacy">Privacy Policy</a>.
            </p>
          </div>
        </section>
      )}

      {/* ---------------- 01 Ready to ride ---------------- */}
      {screen === 'ready' && (
        <section style={{ minHeight: '100vh', position: 'relative', background: '#0d0f15' }}>
          <div style={{ position: 'absolute', inset: 0 }}>
            <FleetMap
              state={{
                center: [site.lat, site.lng],
                zoom: 16,
                units: units.slice(0, 8),
                fence,
                theme: 'dark',
                markerStyle: 'pin',
              }}
            />
          </div>
          <div
            className="sheet"
            style={{
              position: 'absolute',
              zIndex: 700,
              left: 0,
              right: 0,
              bottom: 0,
              background: 'var(--card-bg)',
              color: 'var(--ink)',
              borderRadius: '30px 30px 0 0',
              padding: '30px 24px 34px',
              boxShadow: '0 -12px 40px rgba(10,12,20,.3)',
            }}
          >
            <h1 style={{ ...headingStyle, margin: '0 0 14px', fontSize: 37, lineHeight: 1.02 }}>Ready to ride?</h1>
            <p style={{ margin: '0 0 22px', fontSize: 19, lineHeight: 1.35, color: 'var(--muted)' }}>
              Have you used a shared wheelchair before?
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <button
                className="row"
                onClick={() => {
                  setHowStep(0);
                  setScreen('how');
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 16,
                  padding: 16,
                  minHeight: 92,
                  border: '1px solid var(--hair)',
                  borderRadius: 20,
                  background: 'transparent',
                  color: 'inherit',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <span
                  style={{
                    width: 62,
                    height: 62,
                    borderRadius: 16,
                    background: 'var(--tint-bg)',
                    display: 'grid',
                    placeItems: 'center',
                    flex: 'none',
                  }}
                >
                  <Icon d={ICON.route} size={30} stroke="#3d7bfd" />
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ ...headingStyle, display: 'block', fontSize: 19 }}>First time</span>
                  <span style={{ display: 'block', fontSize: 15, color: 'var(--muted)' }}>
                    Show me how it works
                  </span>
                </span>
                <Chevron color="var(--muted)" size={22} />
              </button>

              <button
                className="row"
                onClick={() => setScreen('rules')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 16,
                  padding: 16,
                  minHeight: 92,
                  border: '1px solid var(--hair)',
                  borderRadius: 20,
                  background: 'transparent',
                  color: 'inherit',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <span
                  style={{
                    width: 62,
                    height: 62,
                    borderRadius: 16,
                    background: 'var(--tint-bg)',
                    display: 'grid',
                    placeItems: 'center',
                    flex: 'none',
                  }}
                >
                  <Icon d={ICON.star} size={30} stroke="var(--accent)" />
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ ...headingStyle, display: 'block', fontSize: 19 }}>I&apos;ve done this</span>
                  <span style={{ display: 'block', fontSize: 15, color: 'var(--muted)' }}>Take me to the map</span>
                </span>
                <Chevron color="var(--muted)" size={22} />
              </button>
            </div>
          </div>
        </section>
      )}

      {/* ---------------- 02 How it works ---------------- */}
      {screen === 'how' && (
        <section
          style={{
            minHeight: '100vh',
            background: 'var(--card-bg)',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div style={{ padding: '16px 16px 0', display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              onClick={() => (howStep === 0 ? setScreen('ready') : setHowStep(howStep - 1))}
              aria-label="Back"
              style={{
                width: 42,
                height: 42,
                border: 0,
                borderRadius: 999,
                background: 'var(--tint-bg)',
                color: 'var(--ink)',
                display: 'grid',
                placeItems: 'center',
                cursor: 'pointer',
              }}
            >
              <Chevron dir="left" />
            </button>
            <div style={{ flex: 1, display: 'flex', gap: 5 }}>
              {HOW_STEPS.map((_, i) => (
                <span
                  key={i}
                  style={{
                    flex: 1,
                    height: 4,
                    borderRadius: 999,
                    background: i <= howStep ? 'var(--accent)' : 'var(--hair)',
                    transition: 'background .3s ease',
                  }}
                />
              ))}
            </div>
            <button
              onClick={goMap}
              style={{
                minHeight: 42,
                padding: '0 12px',
                border: 0,
                background: 'transparent',
                color: 'var(--muted)',
                fontSize: 14,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              Skip
            </button>
          </div>

          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              padding: '20px 22px',
              gap: 24,
            }}
          >
            <span
              style={{
                width: 96,
                height: 96,
                borderRadius: 28,
                background: 'var(--tint-bg)',
                display: 'grid',
                placeItems: 'center',
              }}
            >
              <Icon d={HOW_STEPS[howStep].icon} size={48} stroke="var(--accent)" width={1.5} />
            </span>
            <div>
              <span
                style={{
                  display: 'block',
                  fontSize: 12,
                  fontWeight: 800,
                  letterSpacing: '.1em',
                  textTransform: 'uppercase',
                  color: 'var(--accent)',
                  marginBottom: 8,
                }}
              >
                Step {howStep + 1} of {HOW_STEPS.length}
              </span>
              <h1 style={{ ...headingStyle, margin: '0 0 10px', fontSize: 30, lineHeight: 1.08 }}>
                {HOW_STEPS[howStep].title}
              </h1>
              <p style={{ margin: 0, fontSize: 17, lineHeight: 1.45, color: 'var(--muted)' }}>
                {HOW_STEPS[howStep].body}
              </p>
            </div>
          </div>

          <div style={{ padding: '0 20px calc(26px + env(safe-area-inset-bottom))' }}>
            <button
              onClick={() => (howStep === HOW_STEPS.length - 1 ? setScreen('rules') : setHowStep(howStep + 1))}
              style={{
                width: '100%',
                minHeight: 58,
                border: 0,
                borderRadius: 999,
                background: 'var(--accent)',
                color: '#fff',
                fontSize: 17,
                fontWeight: 800,
                cursor: 'pointer',
              }}
            >
              {howStep === HOW_STEPS.length - 1 ? 'Next: the rules' : 'Next'}
            </button>
          </div>
        </section>
      )}

      {/* ---------------- 02 Rules ---------------- */}
      {screen === 'rules' && (
        <section
          style={{
            minHeight: '100vh',
            background: 'var(--card-bg)',
            display: 'flex',
            flexDirection: 'column',
            padding: '18px 22px 26px',
          }}
        >
          <button
            onClick={() => setScreen(session?.onboarded ? 'app' : 'ready')}
            aria-label="Back"
            style={{
              alignSelf: 'flex-start',
              width: 42,
              height: 42,
              marginBottom: 10,
              border: 0,
              borderRadius: 999,
              background: 'var(--tint-bg)',
              color: 'var(--ink)',
              display: 'grid',
              placeItems: 'center',
              cursor: 'pointer',
            }}
          >
            <Chevron dir="left" />
          </button>
          <h1 style={{ ...headingStyle, margin: '0 0 30px', fontSize: 40, lineHeight: 1 }}>
            Rules in {site.short}
          </h1>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 26, flex: 1 }}>
            {RULES.map((r, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
                <span style={{ width: 44, flex: 'none', display: 'grid', placeItems: 'center' }}>
                  <Icon d={r.icon} size={34} width={1.5} />
                </span>
                <span style={{ fontSize: 17.5, lineHeight: 1.35 }}>{r.text}</span>
              </div>
            ))}
          </div>
          <button
            onClick={goMap}
            style={{
              marginTop: 26,
              minHeight: 64,
              border: 0,
              borderRadius: 999,
              background: 'var(--ink)',
              color: 'var(--app-bg)',
              fontSize: 18,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            Got it
          </button>
        </section>
      )}

      {/* ---------------- 03 Rider app ---------------- */}
      {screen === 'app' && (
        <div style={{ position: 'relative', minHeight: '100vh', background: 'var(--app-bg)' }}>
          {tab === 'map' && (
            <>
              <div style={{ position: 'fixed', inset: 0 }}>
                <FleetMap state={mapState} onPickUnit={onPickUnit} />
              </div>

              {/* floating top bar */}
              <div
                style={{
                  position: 'fixed',
                  top: 0,
                  left: 0,
                  right: 0,
                  padding: 'calc(14px + env(safe-area-inset-top)) 16px 0',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  zIndex: 660,
                  pointerEvents: 'none',
                }}
              >
                {canGoBack && (
                  <button onClick={goBack} aria-label="Back" style={floatBtn}>
                    <Chevron dir="left" />
                  </button>
                )}
                <button
                  onClick={() => setCityOpen(true)}
                  style={{
                    pointerEvents: 'auto',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 9,
                    minHeight: 44,
                    padding: '0 14px',
                    border: '1px solid var(--hair)',
                    borderRadius: 999,
                    background: 'var(--float-bg)',
                    color: 'var(--ink)',
                    fontSize: 14.5,
                    fontWeight: 700,
                    cursor: 'pointer',
                    boxShadow: '0 6px 18px rgba(10,12,20,.22)',
                    maxWidth: '62%',
                  }}
                >
                  <Icon d={ICON.pin} size={17} width={2} />
                  <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {cityLabel}
                  </span>
                  <Chevron dir="down" size={15} />
                </button>
                <button
                  onClick={toggleTheme}
                  aria-label="Switch theme"
                  style={{ ...floatBtn, width: 44, height: 44 }}
                >
                  <Icon d={theme === 'dark' ? ICON.moon : ICON.sun} size={19} width={1.9} />
                </button>
              </div>

              {/* right control stack */}
              <div
                style={{
                  position: 'fixed',
                  right: 16,
                  top: 'calc(76px + env(safe-area-inset-top))',
                  zIndex: 660,
                  display: 'flex',
                  flexDirection: 'column',
                  background: 'var(--float-bg)',
                  borderRadius: 999,
                  border: '1px solid var(--hair)',
                  boxShadow: '0 8px 22px rgba(10,12,20,.24)',
                  overflow: 'hidden',
                }}
              >
                <button
                  onClick={() => setFit(Date.now())}
                  aria-label="Show allowed area"
                  style={{
                    width: 50,
                    height: 50,
                    border: 0,
                    background: 'transparent',
                    color: 'var(--ink)',
                    display: 'grid',
                    placeItems: 'center',
                    cursor: 'pointer',
                  }}
                >
                  <Icon d={ICON.fit} size={21} width={1.9} />
                </button>
                <span style={{ height: 1, background: 'var(--hair)' }} />
                <button
                  onClick={() => {
                    if (!geo && geoState !== 'asking') askLocation();
                    setRecenter(Date.now());
                  }}
                  aria-label="Centre on me"
                  style={{
                    width: 50,
                    height: 50,
                    border: 0,
                    background: 'transparent',
                    color: 'var(--ink)',
                    display: 'grid',
                    placeItems: 'center',
                    cursor: 'pointer',
                  }}
                >
                  <Icon d={ICON.navigate} size={21} width={1.9} />
                </button>
              </div>
            </>
          )}

          {/* ---------- sheet A/B: nearest + selection ---------- */}
          {tab === 'map' && !ride && !receipt && (
            <div className="sheet" style={sheetStyle}>
              <span
                style={{
                  display: 'block',
                  width: 34,
                  height: 4,
                  borderRadius: 999,
                  background: 'var(--hair)',
                  margin: '0 auto 9px',
                }}
              />

              {chosen ? (
                /* ---- b) a scanned chair is selected ---- */
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span
                      style={{
                        width: 34,
                        height: 34,
                        borderRadius: 11,
                        background: 'var(--tint-bg)',
                        display: 'grid',
                        placeItems: 'center',
                        flex: 'none',
                      }}
                    >
                      <Icon d={ICON.chair} size={26} stroke="var(--accent)" width={1.6} />
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ ...headingStyle, display: 'block', fontSize: 16.5 }}>
                        Chair {shortId(chosen.wheelchair_id)}
                      </span>
                      <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)' }}>
                        {unlockStage === 'idle' ? 'ready to unlock' : 'waiting for the chair…'}
                      </span>
                    </span>
                    <button
                      onClick={() => {
                        setChosenId(null);
                        setRiderError('');
                      }}
                      style={{
                        flex: 'none',
                        minHeight: 38,
                        padding: '0 14px',
                        border: '1px solid var(--hair)',
                        borderRadius: 999,
                        background: 'transparent',
                        color: 'var(--ink)',
                        fontSize: 13,
                        fontWeight: 700,
                        cursor: 'pointer',
                      }}
                    >
                      Change
                    </button>
                  </div>

                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(3,1fr)',
                      gap: 8,
                      margin: '10px 0 8px',
                    }}
                  >
                    {[
                      { k: 'Walk', v: previewMetres == null ? '—' : walkMins(previewMetres) },
                      { k: 'Battery', v: battLabel(chosen.batt_pct) },
                      { k: 'Range', v: rangeLabel(chosen.batt_pct) },
                    ].map((t) => (
                      <div key={t.k} style={{ padding: '9px 11px', borderRadius: 14, background: 'var(--tint-bg)' }}>
                        <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>{t.k}</div>
                        <div style={{ fontWeight: 800, fontSize: 14 }}>{t.v}</div>
                      </div>
                    ))}
                  </div>

                  <p style={{ margin: '0 0 9px', fontSize: 11.5, color: 'var(--muted)' }}>
                    SAR {UNLOCK_FEE} to unlock, then SAR {PER_MIN.toFixed(2)} a minute · never more than SAR{' '}
                    {DAY_CAP} a day
                  </p>

                  <button
                    {...(unlockStage === 'idle' ? unlockHold.handlers : {})}
                    disabled={unlockStage !== 'idle'}
                    style={{
                      position: 'relative',
                      overflow: 'hidden',
                      width: '100%',
                      minHeight: 48,
                      border: 0,
                      borderRadius: 15,
                      background: 'var(--accent)',
                      color: '#fff',
                      fontSize: 15,
                      fontWeight: 800,
                      cursor: unlockStage === 'idle' ? 'pointer' : 'progress',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      opacity: unlockStage === 'idle' ? 1 : 0.85,
                    }}
                  >
                    <span
                      style={{
                        position: 'absolute',
                        left: 0,
                        top: 0,
                        bottom: 0,
                        width: unlockHold.pctLabel,
                        background: 'rgba(255,255,255,.3)',
                      }}
                    />
                    <span style={{ position: 'relative' }}>
                      {unlockStage === 'creating'
                        ? 'Opening a rental…'
                        : unlockStage === 'paying'
                          ? 'Authorising SAR 15…'
                          : unlockStage === 'waiting'
                            ? 'Waiting for the chair…'
                            : unlockHold.pct > 0
                              ? 'Hold…'
                              : 'Hold to unlock'}
                    </span>
                  </button>
                </div>
              ) : (
                /* ---- a) nothing chosen yet: nearest chair + scan ---- */
                <div>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ ...headingStyle, display: 'block', fontSize: 15.5, lineHeight: 1.2 }}>
                        {loading
                          ? 'Looking for chairs…'
                          : preview
                            ? previewId && preview.wheelchair_id === previewId
                              ? `Chair ${shortId(preview.wheelchair_id)}`
                              : `Chair ${shortId(preview.wheelchair_id)} is closest`
                            : 'No chairs free here'}
                      </span>
                      <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                        {preview
                          ? previewMetres == null
                            ? 'Position not reported — scan its code when you find it'
                            : `${walkMins(previewMetres)} walk · ${fmtDist(previewMetres)} away · walk here and scan it`
                          : fleetError
                            ? fleetError
                            : 'Try another area from the city picker'}
                      </span>
                    </span>
                    <span style={{ flex: 'none', textAlign: 'right' }}>
                      <span style={{ ...headingStyle, display: 'block', fontSize: 16 }}>
                        {battLabel(preview?.batt_pct)}
                      </span>
                      <span style={{ display: 'block', fontSize: 11.5, color: 'var(--muted)' }}>battery</span>
                    </span>
                  </div>

                  {(geoState === 'prompt' || geoState === 'asking' || geoState === 'denied' ||
                    geoState === 'unavailable') && (
                    <button
                      onClick={askLocation}
                      disabled={geoState === 'asking'}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 9,
                        width: '100%',
                        marginTop: 10,
                        minHeight: 44,
                        padding: '0 13px',
                        border: '1px solid var(--hair)',
                        borderRadius: 14,
                        background: 'transparent',
                        color: 'var(--ink)',
                        fontSize: 12.5,
                        fontWeight: 700,
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      <Icon d={ICON.pin} size={17} stroke="var(--accent)" width={2} />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        {geoState === 'asking'
                          ? 'Finding you…'
                          : geoState === 'denied'
                            ? `Location is off — distances are from ${site.short}. Tap to retry.`
                            : geoState === 'unavailable'
                              ? `This device cannot share a location — distances are from ${site.short}.`
                              : 'Use my location for accurate walking distances'}
                      </span>
                    </button>
                  )}

                  <div
                    className="noscroll"
                    style={{ display: 'flex', gap: 7, margin: '11px 0 9px', overflowX: 'auto' }}
                  >
                    {nearby.slice(0, 6).map((n) => (
                      <button
                        key={n.d.wheelchair_id}
                        onClick={() => onPickUnit(n.d.wheelchair_id)}
                        style={{
                          flex: 'none',
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'flex-start',
                          gap: 1,
                          padding: '8px 12px',
                          border:
                            n.d.wheelchair_id === previewId
                              ? '1px solid var(--accent)'
                              : '1px solid var(--hair)',
                          borderRadius: 14,
                          background: 'transparent',
                          color: 'var(--ink)',
                          cursor: 'pointer',
                          textAlign: 'left',
                        }}
                      >
                        <span style={{ fontWeight: 800, fontSize: 14 }}>
                          Chair {shortId(n.d.wheelchair_id)}
                        </span>
                        <span style={{ fontSize: 11.5, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                          {Number.isFinite(n.m) ? `${walkMins(n.m)} · ` : ''}
                          {battLabel(n.d.batt_pct)}
                        </span>
                      </button>
                    ))}
                    {!loading && positionsReady && nearby.length === 0 && (
                      <span style={{ fontSize: 12, color: 'var(--muted)', padding: '10px 2px' }}>
                        No chair here is above 25% battery right now.
                      </span>
                    )}
                  </div>

                  <button
                    onClick={openScanner}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 10,
                      width: '100%',
                      minHeight: 48,
                      border: 0,
                      borderRadius: 15,
                      background: 'var(--accent)',
                      color: '#fff',
                      fontSize: 15,
                      fontWeight: 800,
                      cursor: 'pointer',
                    }}
                  >
                    <Icon d={ICON.scanFrame} size={20} width={1.9} />
                    <span>Scan the code on the chair</span>
                  </button>
                </div>
              )}

              {geoNote && (
                <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--muted)' }}>{geoNote}</p>
              )}
              {riderError && (
                <p style={{ margin: '10px 0 0', fontSize: 13.5, color: 'var(--accent)' }}>{riderError}</p>
              )}
            </div>
          )}

          {/* ---------- sheet C: riding ---------- */}
          {tab === 'map' && ride && (
            <div className="sheet" style={sheetStyle}>
              <span
                style={{
                  display: 'block',
                  width: 34,
                  height: 4,
                  borderRadius: 999,
                  background: 'var(--hair)',
                  margin: '0 auto 9px',
                }}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 6 }}>
                <span
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: 999,
                    background: 'var(--accent)',
                    animation: 'beat 1.5s ease-in-out infinite',
                  }}
                />
                <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '.02em', color: 'var(--muted)' }}>
                  Riding {shortId(ride.chairId)}
                </span>
                <button
                  onClick={() => {
                    setTab('help');
                    say('Depot contact is on the help page');
                  }}
                  style={{
                    marginLeft: 'auto',
                    minHeight: 38,
                    padding: '0 14px',
                    border: '1px solid var(--hair)',
                    borderRadius: 999,
                    background: 'transparent',
                    color: 'var(--ink)',
                    fontSize: 13,
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  Get help
                </button>
              </div>

              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 18, flexWrap: 'wrap' }}>
                <span>
                  <span style={{ ...headingStyle, display: 'block', fontSize: 32, lineHeight: 1 }}>
                    {mmss(rideSeconds)}
                  </span>
                  <span style={{ display: 'block', fontSize: 13, color: 'var(--muted)', marginTop: 3 }}>
                    time riding
                  </span>
                </span>
                <span style={{ textAlign: 'center' }}>
                  <span
                    style={{ ...headingStyle, display: 'block', fontSize: 22, lineHeight: 1, color: 'var(--accent)' }}
                  >
                    {rideChairOnline && realSpeedKmh(rideChair) !== null
                      ? (realSpeedKmh(rideChair) as number).toFixed(1)
                      : '—'}
                  </span>
                  <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>km/h</span>
                </span>
                <span style={{ marginLeft: 'auto', textAlign: 'right' }}>
                  <span style={{ ...headingStyle, display: 'block', fontSize: 22, lineHeight: 1 }}>
                    {sar(liveFee)}
                  </span>
                  <span style={{ display: 'block', fontSize: 13, color: 'var(--muted)', marginTop: 3 }}>
                    est. · {fmtDist(rideMetres)} so far
                  </span>
                </span>
              </div>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  marginTop: 12,
                  padding: '9px 12px',
                  borderRadius: 14,
                  background: safeToEnd ? 'rgba(31,157,85,.14)' : 'var(--tint-bg)',
                  color: safeToEnd ? '#137a45' : 'var(--accent-600)',
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 999,
                    background: 'currentColor',
                    flex: 'none',
                    animation: safeToEnd ? 'none' : 'beat 1.1s ease-in-out infinite',
                  }}
                />
                <span style={{ fontSize: 12.5, fontWeight: 700 }}>
                  {!rideChair || !rideChairOnline
                    ? 'Connection to the chair lost — waiting for it to report…'
                    : safeToEnd
                      ? 'Chair is stopped — safe to end the ride'
                      : realSpeedKmh(rideChair) !== null
                        ? `Moving at ${(realSpeedKmh(rideChair) as number).toFixed(1)} km/h — stop before ending`
                        : 'The chair is still moving — stop before ending'}
                </span>
                <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 700, opacity: 0.8 }}>
                  {battLabel(rideChair?.batt_pct)}
                </span>
              </div>

              {breach && (
                <p style={{ margin: '10px 0 0', fontSize: 12.5, fontWeight: 700, color: 'var(--accent)' }}>
                  You are outside the allowed area — the chair will slow itself down. Please return.
                </p>
              )}

              <div
                style={{
                  height: 6,
                  borderRadius: 999,
                  background: 'var(--tint-bg)',
                  margin: '12px 0 8px',
                  overflow: 'hidden',
                }}
              >
                <span
                  style={{
                    display: 'block',
                    height: '100%',
                    borderRadius: 999,
                    background: 'var(--accent)',
                    width: `${Math.min(100, (liveFee / DAY_CAP) * 100).toFixed(1)}%`,
                    transition: 'width .6s linear',
                  }}
                />
              </div>
              <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--muted)' }}>
                {liveFee >= DAY_CAP
                  ? 'Daily cap reached — the rest of today is free'
                  : `${sar(DAY_CAP - liveFee)} left before today's cap · this counter is an estimate, the depot issues the invoice`}
              </p>

              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  onClick={ringChair}
                  disabled={ringing}
                  aria-label="Ring the chair"
                  style={{
                    width: 48,
                    height: 48,
                    flex: 'none',
                    border: '1px solid var(--hair)',
                    borderRadius: 15,
                    background: ringing ? 'var(--accent)' : 'transparent',
                    color: ringing ? '#fff' : 'var(--ink)',
                    display: 'grid',
                    placeItems: 'center',
                    cursor: ringing ? 'progress' : 'pointer',
                  }}
                >
                  <Icon d={ICON.bell} size={24} width={1.8} />
                </button>
                <button
                  {...(ending ? {} : endHold.handlers)}
                  disabled={ending}
                  style={{
                    position: 'relative',
                    overflow: 'hidden',
                    flex: 1,
                    minHeight: 48,
                    border: 0,
                    borderRadius: 15,
                    background: safeToEnd ? 'var(--ink)' : 'var(--hair)',
                    color: safeToEnd ? 'var(--app-bg)' : 'var(--muted)',
                    fontSize: 15,
                    fontWeight: 800,
                    cursor: ending ? 'progress' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <span
                    style={{
                      position: 'absolute',
                      left: 0,
                      top: 0,
                      bottom: 0,
                      width: endHold.pctLabel,
                      background: 'var(--accent)',
                    }}
                  />
                  <span style={{ position: 'relative' }}>
                    {ending
                      ? 'Locking the chair…'
                      : endHold.pct > 0
                        ? 'Hold…'
                        : safeToEnd
                          ? 'Hold to end ride'
                          : 'Stop to end ride'}
                  </span>
                </button>
              </div>

              {riderError && (
                <p style={{ margin: '9px 0 0', fontSize: 12.5, color: 'var(--accent)' }}>{riderError}</p>
              )}
            </div>
          )}

          {/* ---------- receipt ---------- */}
          {tab === 'map' && !ride && receipt && (
            <div
              className="sheet"
              style={{
                ...sheetStyle,
                padding: '20px 16px calc(92px + env(safe-area-inset-bottom))',
                boxShadow: '0 -10px 34px rgba(10,12,20,.26)',
              }}
            >
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '7px 13px',
                  borderRadius: 999,
                  background: 'rgba(31,157,85,.14)',
                  color: '#137a45',
                  fontSize: 13,
                  fontWeight: 700,
                  marginBottom: 14,
                }}
              >
                Ride finished
              </span>
              <h2 style={{ ...headingStyle, margin: '0 0 6px', fontSize: 32 }}>{sar(receipt.fee)}</h2>
              <p style={{ margin: '0 0 18px', fontSize: 15, color: 'var(--muted)' }}>
                {Math.floor(receipt.seconds / 60)} min · {fmtDist(receipt.meters)} · chair{' '}
                {shortId(receipt.chairId)} · estimate, the depot issues the invoice
              </p>
              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  onClick={() => setReceipt(null)}
                  style={{
                    flex: 1,
                    minHeight: 60,
                    border: '1px solid var(--hair)',
                    borderRadius: 22,
                    background: 'transparent',
                    color: 'var(--ink)',
                    fontSize: 16,
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  Done
                </button>
                <button
                  onClick={() => {
                    setReceipt(null);
                    setTab('trips');
                  }}
                  style={{
                    flex: 1,
                    minHeight: 60,
                    border: 0,
                    borderRadius: 22,
                    background: 'var(--ink)',
                    color: 'var(--app-bg)',
                    fontSize: 16,
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  See receipt
                </button>
              </div>
            </div>
          )}

          {/* ---------- Passes ---------- */}
          {tab === 'pass' && (
            <div style={tabPage}>
              <button
                onClick={() => setTab('map')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  minHeight: 42,
                  border: 0,
                  background: 'transparent',
                  color: 'var(--ink)',
                  fontSize: 14.5,
                  fontWeight: 700,
                  cursor: 'pointer',
                  padding: 0,
                }}
              >
                <Chevron dir="left" size={19} />
                <span>Map</span>
              </button>
              <h1 style={{ ...headingStyle, margin: '0 0 4px', fontSize: 28 }}>Passes</h1>
              <p style={{ margin: '0 0 22px', fontSize: 15, color: 'var(--muted)' }}>
                Skip the unlock fee while you are in the city.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {[
                  {
                    name: 'Pay as you go',
                    detail: `SAR ${UNLOCK_FEE} to unlock, then SAR ${PER_MIN.toFixed(2)} a minute`,
                    price: 'Active',
                    active: true,
                    note: 'You are already on pay as you go',
                  },
                  {
                    name: 'Day pass',
                    detail: 'No unlock fees for 24 hours',
                    price: 'SAR 45',
                    active: false,
                    note: 'Passes are not on sale in this build yet',
                  },
                  {
                    name: 'Umrah week',
                    detail: 'No unlock fees for 7 days',
                    price: 'SAR 180',
                    active: false,
                    note: 'Passes are not on sale in this build yet',
                  },
                ].map((p) => (
                  <button
                    key={p.name}
                    className="row"
                    onClick={() => say(p.note)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 14,
                      padding: 18,
                      border: p.active ? '2px solid var(--accent)' : '1px solid var(--hair)',
                      borderRadius: 24,
                      background: p.active ? 'transparent' : 'var(--card-bg)',
                      color: 'var(--ink)',
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                  >
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ ...headingStyle, display: 'block', fontSize: 19 }}>{p.name}</span>
                      <span style={{ display: 'block', fontSize: 14, opacity: 0.72, marginTop: 2 }}>
                        {p.detail}
                      </span>
                    </span>
                    <span style={{ ...headingStyle, flex: 'none', fontSize: 19 }}>{p.price}</span>
                  </button>
                ))}
              </div>
              <div style={{ marginTop: 22, padding: 18, borderRadius: 24, background: 'var(--card-bg)' }}>
                <h3 style={{ ...headingStyle, margin: '0 0 8px', fontSize: 17 }}>How billing works</h3>
                <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.55, color: 'var(--muted)' }}>
                  Every ride starts with SAR {UNLOCK_FEE}, then SAR {PER_MIN.toFixed(2)} for each minute. You
                  never pay more than SAR {DAY_CAP} in one day. The counter on the map is an estimate — the
                  depot works out the final amount from the chair&apos;s own start and end times.
                </p>
              </div>
            </div>
          )}

          {/* ---------- Help ---------- */}
          {tab === 'help' && (
            <div style={tabPage}>
              <button
                onClick={() => setTab('map')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  minHeight: 42,
                  border: 0,
                  background: 'transparent',
                  color: 'var(--ink)',
                  fontSize: 14.5,
                  fontWeight: 700,
                  cursor: 'pointer',
                  padding: 0,
                }}
              >
                <Chevron dir="left" size={19} />
                <span>Map</span>
              </button>
              <h1 style={{ ...headingStyle, margin: '0 0 4px', fontSize: 28 }}>Help</h1>
              <p style={{ margin: '0 0 20px', fontSize: 15, color: 'var(--muted)' }}>
                Staff are on site every day from 04:00 to 01:00.
              </p>
              <a
                href={`tel:${DEPOT_PHONE}`}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  padding: 20,
                  borderRadius: 24,
                  background: 'var(--accent)',
                  color: '#fff',
                  textAlign: 'left',
                  marginBottom: 12,
                }}
              >
                <Icon d={ICON.headset} size={26} width={1.8} />
                <span>
                  <span style={{ ...headingStyle, display: 'block', fontSize: 19 }}>Call the depot now</span>
                  <span style={{ display: 'block', fontSize: 14, opacity: 0.9 }}>
                    {ride ? `Someone will come to chair ${shortId(ride.chairId)}` : 'Someone will come to you'}
                  </span>
                </span>
              </a>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {FAQ.map((f, i) => (
                  <button
                    key={f.q}
                    className="row"
                    onClick={() => setHelpOpen(helpOpen === i ? null : i)}
                    style={cardRow}
                  >
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontWeight: 700, fontSize: 16 }}>{f.q}</span>
                      {helpOpen === i && (
                        <span
                          style={{
                            display: 'block',
                            fontSize: 14.5,
                            lineHeight: 1.55,
                            color: 'var(--muted)',
                            marginTop: 8,
                          }}
                        >
                          {f.a}
                        </span>
                      )}
                    </span>
                    <Chevron
                      dir="down"
                      style={{ transform: helpOpen === i ? 'rotate(180deg)' : 'none', transition: 'transform .25s ease' }}
                    />
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ---------- Profile ---------- */}
          {tab === 'profile' && (
            <div style={{ ...tabPage, padding: '20px 20px 120px' }}>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  onClick={() => setAccountOpen(true)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 9,
                    minHeight: 46,
                    padding: '0 18px',
                    border: '1px solid var(--hair)',
                    borderRadius: 999,
                    background: 'transparent',
                    color: 'var(--ink)',
                    fontSize: 15,
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  <Icon d={ICON.sun} size={18} width={1.9} />
                  <span>Account</span>
                </button>
              </div>
              <h1 style={{ ...headingStyle, margin: '6px 0 18px', fontSize: 28 }}>
                Hi, {session?.name ?? 'there'}
              </h1>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3,1fr)',
                  gap: 10,
                  marginBottom: 18,
                }}
              >
                {[
                  { label: 'Wallet', icon: ICON.wallet, go: () => say('Payment is settled by the depot in this build') },
                  { label: 'Receipts', icon: ICON.receipt, go: () => setTab('trips') },
                  { label: 'Inbox', icon: ICON.inbox, go: () => say('No new messages') },
                ].map((q) => (
                  <button
                    key={q.label}
                    className="row"
                    onClick={q.go}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 9,
                      minHeight: 96,
                      border: '1px solid var(--hair)',
                      borderRadius: 22,
                      background: 'transparent',
                      color: 'var(--ink)',
                      cursor: 'pointer',
                    }}
                  >
                    <Icon d={q.icon} size={26} />
                    <span style={{ fontSize: 14, fontWeight: 700 }}>{q.label}</span>
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {[
                  {
                    title: 'Your rides',
                    sub: `${accountTrips.length} ${accountTrips.length === 1 ? 'ride' : 'rides'} · ${sar(totalSpend)}`,
                    icon: ICON.clock,
                    go: () => setTab('trips'),
                  },
                  {
                    title: 'Payment method',
                    sub: 'Settled at the depot',
                    icon: ICON.card,
                    go: () => say('Card management is not part of this build'),
                  },
                  {
                    title: 'Language',
                    sub: lang,
                    icon: ICON.globe,
                    go: toggleLanguage,
                  },
                  {
                    title: 'Safety and rules',
                    sub: `How to ride in ${site.short}`,
                    icon: ICON.shield,
                    go: () => setScreen('rules'),
                  },
                  {
                    title: 'Account',
                    sub: session?.email ?? '',
                    icon: ICON.profile,
                    go: () => setAccountOpen(true),
                  },
                ].map((r) => (
                  <button key={r.title} className="row" onClick={r.go} style={cardRow}>
                    <Icon d={r.icon} size={26} width={1.6} />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontWeight: 700, fontSize: 17 }}>{r.title}</span>
                      {r.sub && (
                        <span style={{ display: 'block', fontSize: 14, color: 'var(--muted)', marginTop: 1 }}>
                          {r.sub}
                        </span>
                      )}
                    </span>
                    <Chevron color="var(--muted)" />
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ---------- Trips ---------- */}
          {tab === 'trips' && (
            <div style={{ ...tabPage, padding: '20px 20px 120px' }}>
              <button
                onClick={() => setTab('profile')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  minHeight: 44,
                  border: 0,
                  background: 'transparent',
                  color: 'var(--ink)',
                  fontSize: 15,
                  fontWeight: 700,
                  cursor: 'pointer',
                  padding: 0,
                }}
              >
                <Chevron dir="left" />
                <span>Profile</span>
              </button>
              <h1 style={{ ...headingStyle, margin: '8px 0 4px', fontSize: 28 }}>Your rides</h1>
              <p style={{ margin: '0 0 20px', fontSize: 15, color: 'var(--muted)' }}>
                {sar(totalSpend)} estimated on your account
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {accountTrips.length === 0 && (
                  <div style={{ padding: 18, borderRadius: 20, background: 'var(--card-bg)' }}>
                    <span style={{ fontSize: 15, color: 'var(--muted)' }}>
                      No rides yet. Scan a chair on the map to take your first one.
                    </span>
                  </div>
                )}
                {accountTrips.map((t) => (
                  <div
                    key={t.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 14,
                      padding: 18,
                      borderRadius: 20,
                      background: 'var(--card-bg)',
                    }}
                  >
                    <span
                      style={{
                        width: 44,
                        height: 44,
                        borderRadius: 14,
                        background: 'var(--tint-bg)',
                        display: 'grid',
                        placeItems: 'center',
                        flex: 'none',
                      }}
                    >
                      <Icon d={ICON.chair} size={22} stroke="var(--accent)" />
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontWeight: 700, fontSize: 16 }}>{whenLabel(t.at)}</span>
                      <span style={{ display: 'block', fontSize: 14, color: 'var(--muted)' }}>
                        {/* Distance is GPS-measured on the device that rode; server
                            rows without a local match honestly omit it. */}
                        chair {shortId(t.chairId)} · {Math.floor(t.seconds / 60)} min
                        {t.meters > 0 ? ` · ${fmtDist(t.meters)}` : ''}
                      </span>
                    </span>
                    <span style={{ ...headingStyle, flex: 'none', fontSize: 17 }}>{sar(t.fee)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ---------- bottom nav ---------- */}
          <nav
            style={{
              position: 'fixed',
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 720,
              background: 'var(--nav-bg)',
              backdropFilter: 'blur(18px)',
              WebkitBackdropFilter: 'blur(18px)',
              borderTop: '1px solid var(--hair)',
              display: 'grid',
              gridTemplateColumns: '1fr 1fr 84px 1fr 1fr',
              alignItems: 'end',
              padding: '4px 4px calc(6px + env(safe-area-inset-bottom))',
            }}
          >
            {([
              { key: 'map', label: 'Map', icon: ICON.map },
              { key: 'pass', label: 'Passes', icon: ICON.pass },
              { key: 'scan', label: 'Scan', icon: '' },
              { key: 'help', label: 'Help', icon: ICON.help },
              { key: 'profile', label: 'You', icon: ICON.profile },
            ] as const).map((n) => {
              const isFab = n.key === 'scan';
              const on = !isFab && (tab === n.key || (n.key === 'profile' && tab === 'trips'));
              return (
                <button
                  key={n.key}
                  className="nb"
                  data-on={on ? '1' : '0'}
                  onClick={() => (isFab ? openScanner() : setTab(n.key as Tab))}
                  aria-label={n.label}
                  style={{
                    position: 'relative',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 5,
                    minHeight: 52,
                    border: 0,
                    background: 'transparent',
                    cursor: 'pointer',
                  }}
                >
                  {isFab ? (
                    <>
                      <span
                        style={{
                          position: 'absolute',
                          left: '50%',
                          top: -6,
                          transform: 'translateX(-50%)',
                          width: 42,
                          height: 43,
                          borderRadius: 999,
                          background: 'var(--accent)',
                          display: 'grid',
                          placeItems: 'center',
                          boxShadow: '0 8px 22px rgba(255,86,60,.42)',
                        }}
                      >
                        <Icon d={ICON.qr} size={26} stroke="#fff" width={1.9} />
                      </span>
                      <span
                        style={{
                          position: 'absolute',
                          bottom: 2,
                          left: 0,
                          right: 0,
                          textAlign: 'center',
                          fontSize: 11.5,
                          fontWeight: 700,
                          color: 'var(--muted)',
                        }}
                      >
                        Scan
                      </span>
                    </>
                  ) : (
                    <>
                      <Icon d={n.icon} size={23} />
                      <span style={{ fontSize: 11, fontWeight: 700 }}>{n.label}</span>
                    </>
                  )}
                </button>
              );
            })}
          </nav>
        </div>
      )}

      {/* ---------------- Scanner overlay ---------------- */}
      {scanOpen && (
        <div
          className="fade"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 900,
            background: '#05060a',
            color: '#fff',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              opacity: cam === 'live' || cam === 'done' ? 1 : 0,
              transition: 'opacity .35s ease',
            }}
          />
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background:
                'radial-gradient(circle at 50% 44%, rgba(5,6,10,.16) 0 34%, rgba(5,6,10,.82) 72%)',
            }}
          />

          <div
            style={{
              position: 'relative',
              padding: 'calc(14px + env(safe-area-inset-top)) 16px 0',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <button
              onClick={closeScanner}
              aria-label="Close scanner"
              style={{
                width: 44,
                height: 44,
                flex: 'none',
                border: 0,
                borderRadius: 999,
                background: 'rgba(255,255,255,.16)',
                color: '#fff',
                display: 'grid',
                placeItems: 'center',
                cursor: 'pointer',
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}>
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
            <span style={{ fontWeight: 700, fontSize: 15.5 }}>
              {cam === 'done' ? 'Chair found' : 'Scan the code on the handle'}
            </span>
          </div>

          <div
            style={{
              position: 'relative',
              flex: '1 1 0',
              minHeight: 0,
              display: 'grid',
              placeItems: 'center',
              padding: 12,
            }}
          >
            <div style={{ position: 'relative', width: 'min(68vw, 270px, 42vh)', aspectRatio: '1' }}>
              {(
                [
                  { left: 0, top: 0, radius: '16px 0 0 0', sides: { borderTop: true, borderLeft: true } },
                  { right: 0, top: 0, radius: '0 16px 0 0', sides: { borderTop: true, borderRight: true } },
                  { left: 0, bottom: 0, radius: '0 0 0 16px', sides: { borderBottom: true, borderLeft: true } },
                  { right: 0, bottom: 0, radius: '0 0 16px 0', sides: { borderBottom: true, borderRight: true } },
                ] as ReadonlyArray<{
                  left?: number; right?: number; top?: number; bottom?: number; radius: string;
                  sides: { borderTop?: boolean; borderBottom?: boolean; borderLeft?: boolean; borderRight?: boolean };
                }>
              ).map((c, i) => {
                const colour = cam === 'done' ? '#1f9d55' : '#ff563c';
                const edge = `4px solid ${colour}`;
                return (
                  <span
                    key={i}
                    style={{
                      position: 'absolute',
                      left: 'left' in c ? c.left : undefined,
                      right: 'right' in c ? c.right : undefined,
                      top: 'top' in c ? c.top : undefined,
                      bottom: 'bottom' in c ? c.bottom : undefined,
                      width: 46,
                      height: 46,
                      borderTop: c.sides.borderTop ? edge : undefined,
                      borderBottom: c.sides.borderBottom ? edge : undefined,
                      borderLeft: c.sides.borderLeft ? edge : undefined,
                      borderRight: c.sides.borderRight ? edge : undefined,
                      borderRadius: c.radius,
                      transition: 'border-color .3s ease',
                    }}
                  />
                );
              })}
              {cam !== 'done' && (
                <span
                  style={{
                    position: 'absolute',
                    left: '6%',
                    right: '6%',
                    height: 2,
                    background: '#ff563c',
                    boxShadow: '0 0 16px #ff563c',
                    animation: 'zm-sweep 2.2s ease-in-out infinite',
                  }}
                />
              )}
              {cam === 'done' && (
                <span className="pop" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
                  <span
                    style={{
                      width: 74,
                      height: 74,
                      borderRadius: 999,
                      background: '#1f9d55',
                      display: 'grid',
                      placeItems: 'center',
                      boxShadow: '0 10px 30px rgba(31,157,85,.5)',
                    }}
                  >
                    <svg
                      width="38"
                      height="38"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#fff"
                      strokeWidth={2.6}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M4 12.5l5 5L20 6.5" />
                    </svg>
                  </span>
                </span>
              )}
            </div>
          </div>

          <div
            className="noscroll"
            style={{
              position: 'relative',
              flex: '0 1 auto',
              overflowY: 'auto',
              padding: '0 20px calc(18px + env(safe-area-inset-bottom))',
              display: 'flex',
              flexDirection: 'column',
              gap: 9,
            }}
          >
            <p
              style={{
                margin: '0 0 2px',
                fontSize: 14,
                lineHeight: 1.45,
                color: 'rgba(255,255,255,.72)',
                textAlign: 'center',
              }}
            >
              {cam === 'done'
                ? `Opening chair ${chosenId ? shortId(chosenId) : ''}…`
                : cam === 'denied'
                  ? 'Camera access was blocked. Allow it in your browser settings, or type the code below.'
                  : cam === 'prompt'
                    ? 'Zettamight needs your camera to read the code printed on the chair handle.'
                    : 'Hold your phone steady over the square code.'}
            </p>

            {(cam === 'prompt' || cam === 'denied') && (
              <button
                onClick={() => void requestCamera()}
                style={{
                  minHeight: 54,
                  border: 0,
                  borderRadius: 999,
                  background: 'var(--accent)',
                  color: '#fff',
                  fontSize: 16,
                  fontWeight: 800,
                  cursor: 'pointer',
                }}
              >
                Allow camera access
              </button>
            )}

            {cam !== 'done' && (
              <>
                <button
                  onClick={() => finishScan(null)}
                  style={{
                    minHeight: 46,
                    border: '1px dashed rgba(255,255,255,.4)',
                    borderRadius: 999,
                    background: 'transparent',
                    color: 'rgba(255,255,255,.86)',
                    fontSize: 13.5,
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  Demo: simulate a successful scan
                </button>
                <button
                  onClick={() => setManualOpen(true)}
                  style={{
                    minHeight: 40,
                    border: 0,
                    background: 'transparent',
                    color: 'rgba(255,255,255,.62)',
                    fontSize: 13.5,
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  Type the code instead
                </button>
              </>
            )}

            {manualOpen && cam !== 'done' && (
              <>
                <input
                  value={riderCode}
                  onChange={(e) => {
                    setRiderCode(e.target.value);
                    setRiderError('');
                  }}
                  placeholder="Code on the handle, e.g. 018"
                  style={{
                    minHeight: 54,
                    borderRadius: 16,
                    border: '1px solid rgba(255,255,255,.24)',
                    background: 'rgba(255,255,255,.1)',
                    color: '#fff',
                    padding: '0 16px',
                    fontSize: 16,
                  }}
                />
                <button
                  onClick={confirmCode}
                  style={{
                    minHeight: 54,
                    border: 0,
                    borderRadius: 999,
                    background: '#fff',
                    color: '#14161f',
                    fontSize: 16,
                    fontWeight: 800,
                    cursor: 'pointer',
                  }}
                >
                  Find this chair
                </button>
              </>
            )}

            {riderError && (
              <span style={{ fontSize: 13.5, color: '#ff9b8b', textAlign: 'center' }}>{riderError}</span>
            )}
          </div>
        </div>
      )}

      {/* ---------------- City picker ---------------- */}
      {cityOpen && (
        <div
          onClick={() => setCityOpen(false)}
          className="fade"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 740,
            background: 'rgba(10,12,20,.5)',
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'center',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="sheet"
            style={{
              width: '100%',
              maxWidth: 560,
              background: 'var(--card-bg)',
              color: 'var(--ink)',
              borderRadius: '30px 30px 0 0',
              padding: '24px 20px 30px',
            }}
          >
            <h2 style={{ ...headingStyle, margin: '0 0 16px', fontSize: 26 }}>Where are you?</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {sites.map((s) => {
                const active = s.key === siteKey;
                const n = freeHere.get(s.key) ?? 0;
                return (
                  <button
                    key={s.key}
                    className="row"
                    onClick={() => {
                      setSiteKey(s.key);
                      setCityOpen(false);
                      setPreviewId(null);
                      setRecenter(Date.now());
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 14,
                      padding: 16,
                      border: active ? '2px solid var(--accent)' : '1px solid var(--hair)',
                      borderRadius: 20,
                      background: 'transparent',
                      color: 'var(--ink)',
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                  >
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontWeight: 700, fontSize: 17 }}>{s.label}</span>
                      <span style={{ display: 'block', fontSize: 14, color: 'var(--muted)' }}>
                        {n} {n === 1 ? 'chair' : 'chairs'} free now
                      </span>
                    </span>
                    {active && (
                      <svg
                        width="22"
                        height="22"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="var(--accent)"
                        strokeWidth={2.4}
                        style={{ flex: 'none' }}
                      >
                        <path d="M4 12.5l5 5L20 6.5" />
                      </svg>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ---------------- Account ---------------- */}
      {accountOpen && (
        <div
          className="fade"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 920,
            background: 'var(--app-bg)',
            color: 'var(--ink)',
            overflowY: 'auto',
          }}
        >
          <div
            style={{
              position: 'sticky',
              top: 0,
              background: '#14161f',
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '14px 16px',
            }}
          >
            <button
              onClick={() => setAccountOpen(false)}
              aria-label="Back"
              style={{
                width: 42,
                height: 42,
                border: 0,
                borderRadius: 999,
                background: 'transparent',
                color: '#fff',
                display: 'grid',
                placeItems: 'center',
                cursor: 'pointer',
              }}
            >
              <Chevron dir="left" size={22} />
            </button>
            <span style={{ ...headingStyle, fontSize: 19 }}>Account</span>
          </div>
          <div style={{ padding: '22px 20px 40px', maxWidth: 760, margin: '0 auto' }}>
            {/* Profile photo — Supabase Storage, in a folder named after the
                rider's own user id, which storage RLS enforces. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 22 }}>
              <span
                style={{
                  width: 76,
                  height: 76,
                  borderRadius: 999,
                  flex: 'none',
                  overflow: 'hidden',
                  display: 'grid',
                  placeItems: 'center',
                  background: 'var(--tint-bg)',
                  color: 'var(--accent)',
                  fontSize: 28,
                  fontWeight: 800,
                }}
              >
                {profile?.avatar_url ? (
                  // Not next/image: the host is the Supabase project, which
                  // would need remotePatterns configured to be optimised.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={profile.avatar_url}
                    alt=""
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                ) : (
                  (session?.name ?? '?').charAt(0).toUpperCase()
                )}
              </span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <input
                  ref={avatarInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  onChange={(e) => void pickAvatar(e.target.files?.[0])}
                  style={{ display: 'none' }}
                />
                <button
                  onClick={() => avatarInputRef.current?.click()}
                  disabled={uploadingAvatar}
                  style={{
                    minHeight: 42,
                    padding: '0 18px',
                    border: '1px solid var(--hair)',
                    borderRadius: 999,
                    background: 'transparent',
                    color: 'var(--ink)',
                    fontSize: 14,
                    fontWeight: 700,
                    cursor: uploadingAvatar ? 'progress' : 'pointer',
                  }}
                >
                  {uploadingAvatar ? 'Uploading…' : profile?.avatar_url ? 'Change photo' : 'Add photo'}
                </button>
                <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>JPEG, PNG, WebP or GIF · up to 2 MB</span>
              </div>
            </div>

            <h3 style={{ ...headingStyle, margin: '0 0 12px', fontSize: 24 }}>Personal information</h3>
            <div style={{ borderRadius: 22, background: 'var(--card-bg)', overflow: 'hidden', marginBottom: 26 }}>
              {/* Name and phone are the rider's to edit — they write to their
                  own profiles row (RLS-scoped) and nowhere else. */}
              <div style={{ padding: '16px 18px', borderBottom: '1px solid var(--hair)' }}>
                <label style={{ display: 'block', fontSize: 13.5, fontWeight: 700, color: 'var(--muted)', marginBottom: 6 }}>
                  Name
                </label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  autoComplete="name"
                  style={{
                    width: '100%',
                    minHeight: 48,
                    borderRadius: 14,
                    border: '1px solid var(--hair)',
                    background: 'var(--app-bg)',
                    color: 'var(--ink)',
                    padding: '0 14px',
                    fontSize: 16,
                  }}
                />
              </div>
              <div style={{ padding: '16px 18px', borderBottom: '1px solid var(--hair)' }}>
                <label style={{ display: 'block', fontSize: 13.5, fontWeight: 700, color: 'var(--muted)', marginBottom: 6 }}>
                  Phone
                </label>
                <input
                  type="tel"
                  value={editPhone}
                  onChange={(e) => setEditPhone(e.target.value)}
                  placeholder="+966 5X XXX XXXX"
                  autoComplete="tel"
                  style={{
                    width: '100%',
                    minHeight: 48,
                    borderRadius: 14,
                    border: '1px solid var(--hair)',
                    background: 'var(--app-bg)',
                    color: 'var(--ink)',
                    padding: '0 14px',
                    fontSize: 16,
                  }}
                />
              </div>
              <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--hair)' }}>
                <button
                  onClick={() => void saveProfile()}
                  disabled={savingProfile}
                  style={{
                    minHeight: 46,
                    padding: '0 22px',
                    border: 0,
                    borderRadius: 999,
                    background: 'var(--ink)',
                    color: 'var(--app-bg)',
                    fontSize: 14.5,
                    fontWeight: 800,
                    cursor: savingProfile ? 'progress' : 'pointer',
                  }}
                >
                  {savingProfile ? 'Saving…' : 'Save changes'}
                </button>
              </div>
              {[
                { k: 'Email', v: session?.email ?? '—' },
                {
                  k: 'Member since',
                  v: user?.created_at
                    ? new Date(user.created_at).toLocaleDateString('en', { month: 'long', year: 'numeric' })
                    : '—',
                },
                { k: 'Rider ID', v: session?.id ?? '—' },
              ].map((a) => (
                <div key={a.k} style={{ padding: '16px 18px', borderBottom: '1px solid var(--hair)' }}>
                  <span style={{ display: 'block', fontSize: 16.5, fontWeight: 600 }}>{a.k}</span>
                  <span
                    style={{
                      display: 'block',
                      fontSize: 14.5,
                      color: 'var(--muted)',
                      marginTop: 2,
                      wordBreak: 'break-all',
                    }}
                  >
                    {a.v}
                  </span>
                </div>
              ))}
            </div>

            <h3 style={{ ...headingStyle, margin: '0 0 12px', fontSize: 24 }}>Security</h3>
            <div style={{ borderRadius: 22, background: 'var(--card-bg)', overflow: 'hidden', marginBottom: 26 }}>
              <button
                className="row"
                onClick={() => {
                  setPwOpen((v) => !v);
                  setNewPw('');
                  setPortalErr('');
                }}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '16px 18px',
                  border: 0,
                  borderBottom: '1px solid var(--hair)',
                  background: 'transparent',
                  color: 'var(--ink)',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <span style={{ flex: 1 }}>
                  <span style={{ display: 'block', fontSize: 16.5, fontWeight: 600 }}>Change password</span>
                  <span style={{ display: 'block', fontSize: 14.5, color: 'var(--muted)' }}>
                    At least 8 characters
                  </span>
                </span>
                <Chevron color="var(--muted)" dir={pwOpen ? 'down' : 'right'} />
              </button>
              {pwOpen && (
                <form
                  style={{ padding: '16px 18px', borderBottom: '1px solid var(--hair)', display: 'flex', flexDirection: 'column', gap: 10 }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void savePassword();
                  }}
                >
                  <input
                    type="password"
                    value={newPw}
                    onChange={(e) => {
                      setNewPw(e.target.value);
                      setPortalErr('');
                    }}
                    placeholder="New password"
                    autoComplete="new-password"
                    autoFocus
                    style={{
                      width: '100%',
                      minHeight: 48,
                      borderRadius: 14,
                      border: '1px solid var(--hair)',
                      background: 'var(--app-bg)',
                      color: 'var(--ink)',
                      padding: '0 14px',
                      fontSize: 16,
                    }}
                  />
                  <PasswordMeter password={newPw} />
                  <button
                    type="submit"
                    disabled={savingPw}
                    style={{
                      alignSelf: 'flex-start',
                      minHeight: 46,
                      padding: '0 22px',
                      border: 0,
                      borderRadius: 999,
                      background: 'var(--ink)',
                      color: 'var(--app-bg)',
                      fontSize: 14.5,
                      fontWeight: 800,
                      cursor: savingPw ? 'progress' : 'pointer',
                    }}
                  >
                    {savingPw ? 'Saving…' : 'Save new password'}
                  </button>
                </form>
              )}
              <button
                className="row"
                onClick={signOutAllDevices}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '16px 18px',
                  border: 0,
                  borderBottom: '1px solid var(--hair)',
                  background: 'transparent',
                  color: 'var(--ink)',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <span style={{ flex: 1 }}>
                  <span style={{ display: 'block', fontSize: 16.5, fontWeight: 600 }}>Sign out of all devices</span>
                  <span style={{ display: 'block', fontSize: 14.5, color: 'var(--muted)' }}>
                    Ends every session, including this one
                  </span>
                </span>
                <Chevron color="var(--muted)" />
              </button>
              <button
                className="row"
                onClick={() => {
                  setDeleteOpen((v) => !v);
                  setPortalErr('');
                }}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '16px 18px',
                  border: 0,
                  background: 'transparent',
                  color: 'var(--accent)',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <span style={{ flex: 1 }}>
                  <span style={{ display: 'block', fontSize: 16.5, fontWeight: 600 }}>Delete account</span>
                  <span style={{ display: 'block', fontSize: 14.5, color: 'var(--muted)' }}>
                    Permanent — your sign-in and profile are removed
                  </span>
                </span>
                <Chevron color="var(--muted)" dir={deleteOpen ? 'down' : 'right'} />
              </button>
              {deleteOpen && (
                <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <span style={{ fontSize: 14, color: 'var(--muted)', lineHeight: 1.5 }}>
                    This cannot be undone. Your account and profile are deleted; finished ride
                    records are kept for billing, with your identity removed. You cannot delete
                    the account during a ride.
                  </span>
                  <button
                    onClick={() => void deleteAccount()}
                    disabled={deleting}
                    style={{
                      alignSelf: 'flex-start',
                      minHeight: 46,
                      padding: '0 22px',
                      border: 0,
                      borderRadius: 999,
                      background: 'var(--accent)',
                      color: '#fff',
                      fontSize: 14.5,
                      fontWeight: 800,
                      cursor: deleting ? 'progress' : 'pointer',
                    }}
                  >
                    {deleting ? 'Deleting…' : 'Delete my account forever'}
                  </button>
                </div>
              )}
            </div>

            {(portalMsg || portalErr) && (
              <p
                role={portalErr ? 'alert' : 'status'}
                style={{
                  margin: '0 0 18px',
                  fontSize: 14,
                  fontWeight: 700,
                  color: portalErr ? 'var(--accent-600)' : 'var(--ink)',
                }}
              >
                {portalErr || portalMsg}
              </p>
            )}

            <h3 style={{ ...headingStyle, margin: '0 0 12px', fontSize: 24 }}>Settings</h3>
            <div style={{ borderRadius: 22, background: 'var(--card-bg)', overflow: 'hidden', marginBottom: 26 }}>
              <button
                className="row"
                onClick={toggleLanguage}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '16px 18px',
                  border: 0,
                  borderBottom: '1px solid var(--hair)',
                  background: 'transparent',
                  color: 'var(--ink)',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <span style={{ flex: 1 }}>
                  <span style={{ display: 'block', fontSize: 16.5, fontWeight: 600 }}>Language</span>
                  <span style={{ display: 'block', fontSize: 14.5, color: 'var(--muted)' }}>{lang}</span>
                </span>
                <Chevron color="var(--muted)" />
              </button>
              <button
                className="row"
                onClick={toggleTheme}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '16px 18px',
                  border: 0,
                  background: 'transparent',
                  color: 'var(--ink)',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <span style={{ flex: 1 }}>
                  <span style={{ display: 'block', fontSize: 16.5, fontWeight: 600 }}>Appearance</span>
                  <span style={{ display: 'block', fontSize: 14.5, color: 'var(--muted)' }}>
                    {theme === 'dark' ? 'Dark' : 'Light'}
                  </span>
                </span>
                <Chevron color="var(--muted)" />
              </button>

              {/* Notification preferences live on the profile row, so they are
                  the account's choice rather than this browser's. */}
              {([
                {
                  key: 'ride_receipts' as const,
                  title: 'Ride receipts',
                  sub: 'Email me a summary after each ride',
                  on: profile?.ride_receipts !== false,
                },
                {
                  key: 'marketing_opt_in' as const,
                  title: 'Offers and news',
                  sub: 'Occasional emails about Zettamight',
                  on: profile?.marketing_opt_in === true,
                },
              ]).map((s) => (
                <div
                  key={s.key}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '16px 18px',
                    borderTop: '1px solid var(--hair)',
                  }}
                >
                  <span style={{ flex: 1 }}>
                    <span style={{ display: 'block', fontSize: 16.5, fontWeight: 600 }}>{s.title}</span>
                    <span style={{ display: 'block', fontSize: 14.5, color: 'var(--muted)' }}>{s.sub}</span>
                  </span>
                  <button
                    role="switch"
                    aria-checked={s.on}
                    aria-label={s.title}
                    onClick={() => void setSetting({ [s.key]: !s.on })}
                    style={{
                      flex: 'none',
                      width: 52,
                      height: 30,
                      borderRadius: 999,
                      border: 0,
                      padding: 3,
                      cursor: 'pointer',
                      background: s.on ? 'var(--accent)' : 'color-mix(in srgb, var(--ink) 20%, transparent)',
                      transition: 'background .2s ease',
                      display: 'flex',
                      justifyContent: s.on ? 'flex-end' : 'flex-start',
                    }}
                  >
                    <span
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: 999,
                        background: '#fff',
                        boxShadow: '0 1px 3px rgba(0,0,0,.25)',
                      }}
                    />
                  </button>
                </div>
              ))}
            </div>

            <button
              onClick={signOut}
              style={{
                width: '100%',
                minHeight: 60,
                border: '1px solid var(--hair)',
                borderRadius: 999,
                background: 'transparent',
                color: 'var(--accent)',
                fontSize: 16,
                fontWeight: 800,
                cursor: 'pointer',
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      )}

      {/* ---------------- Fall / emergency overlay ----------------
          The DEVICE decides this: it latches its own fall interlock, cuts the
          relay and sounds its siren, then reports SAFE_FAULT. The app only
          renders that assertion — it never computes the fall itself. */}
      {emergency && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 980,
            background: 'rgba(10,12,20,.86)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
            animation: 'fadeIn .2s ease both',
          }}
        >
          <div
            className="pop"
            style={{
              width: '100%',
              maxWidth: 400,
              background: 'var(--card-bg)',
              color: 'var(--ink)',
              borderRadius: 28,
              border: '1px solid rgba(255,86,60,.45)',
              padding: 26,
              textAlign: 'center',
              boxShadow: '0 24px 60px rgba(10,12,20,.5)',
            }}
          >
            <span
              style={{
                width: 72,
                height: 72,
                borderRadius: 999,
                background: 'rgba(255,86,60,.14)',
                border: '1px solid rgba(255,86,60,.3)',
                display: 'grid',
                placeItems: 'center',
                margin: '0 auto 16px',
                color: 'var(--accent)',
                animation: 'beat 1.1s ease-in-out infinite',
              }}
            >
              <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="4.6" r="2" />
                <path d="M4.5 19.5 9 14l-1.5-4.5 5 1.5 2 3.5 4 1" />
              </svg>
            </span>

            <h2 style={{ fontSize: 26, marginBottom: 8 }}>
              {emergencyIsFall ? 'Fall detected' : 'Emergency stop'}
            </h2>
            <p style={{ margin: '0 0 16px', fontSize: 15, lineHeight: 1.5, color: 'var(--muted)' }}>
              {emergencyIsFall
                ? 'The chair tipped past its safe angle. It has cut its motor and is sounding its alarm. Stay still if you are hurt — help can be called from here.'
                : 'The chair has stopped itself and cut its motor. Its alarm is sounding.'}
            </p>

            <div
              style={{
                background: 'var(--tint-bg)',
                borderRadius: 16,
                padding: '12px 14px',
                fontSize: 12.5,
                fontFamily: 'ui-monospace, Menlo, monospace',
                marginBottom: 16,
                textAlign: 'left',
              }}
            >
              <div style={{ fontSize: 10.5, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 4 }}>
                Location shared with the depot
              </div>
              {rideChair?.lat != null && rideChair?.lng != null
                ? `${rideChair.lat.toFixed(6)}, ${rideChair.lng.toFixed(6)}`
                : 'Waiting for a GPS fix…'}
              {rideChair?.tilt != null && (
                <div style={{ marginTop: 4 }}>tilt {rideChair.tilt.toFixed(0)}°</div>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <a
                href={`tel:${DEPOT_PHONE}`}
                style={{
                  display: 'grid',
                  placeItems: 'center',
                  minHeight: 56,
                  borderRadius: 999,
                  background: 'var(--accent)',
                  color: '#fff',
                  fontSize: 16,
                  fontWeight: 800,
                  textDecoration: 'none',
                }}
              >
                Call the depot for help
              </a>
              <button
                onClick={clearEmergency}
                disabled={clearingEmergency}
                style={{
                  minHeight: 50,
                  border: '1px solid var(--hair)',
                  borderRadius: 999,
                  background: 'transparent',
                  color: 'var(--ink)',
                  fontSize: 15,
                  fontWeight: 700,
                  cursor: clearingEmergency ? 'progress' : 'pointer',
                }}
              >
                {clearingEmergency ? 'Asking the chair…' : 'I am OK — silence the alarm'}
              </button>
            </div>
            {riderError && (
              <p style={{ margin: '12px 0 0', fontSize: 13, color: 'var(--accent)' }}>{riderError}</p>
            )}
          </div>
        </div>
      )}

      {/* ---------------- Toast ---------------- */}
      {toast && (
        <div
          style={{
            position: 'fixed',
            left: '50%',
            transform: 'translateX(-50%)',
            bottom: 112,
            zIndex: 950,
            maxWidth: 'calc(100% - 32px)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '14px 18px',
            borderRadius: 999,
            background: '#14161f',
            color: '#fff',
            boxShadow: '0 12px 30px rgba(10,12,20,.4)',
            fontSize: 14.5,
            fontWeight: 600,
          }}
        >
          <span style={{ width: 8, height: 8, borderRadius: 999, background: 'var(--accent)', flex: 'none' }} />
          <span>{toast}</span>
        </div>
      )}
    </div>
  );
}
