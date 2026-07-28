'use client';

import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { MapState, MapUnit } from '../lib/types';

// React port of source/fleet-map.js — Voi-style pin/arrow markers, dashed
// geofence, ride trail and a pulsing "me" dot. Dynamic-import this with
// { ssr:false } from pages so Leaflet only runs in the browser.

const TILES = {
  dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
};
const ATTR = '© OpenStreetMap contributors © CARTO';

function battColor(b: number) {
  return b < 25 ? '#ff563c' : b < 55 ? '#f0b429' : '#1f9d55';
}

function pinIcon(u: MapUnit, active: boolean) {
  const s = active ? 46 : 38;
  const glow = active
    ? `<span style="position:absolute;left:50%;top:${s * 0.34}px;width:${s * 1.5}px;height:${s * 1.5}px;margin-left:${-s * 0.75}px;margin-top:${-s * 0.75}px;border-radius:999px;background:#ff563c;opacity:.18;animation:fm-ping 2s ease-out infinite"></span>`
    : '';
  const dim = u.status !== 'available' && u.status !== 'rented';
  return L.divIcon({
    className: '',
    iconSize: [s, s + 8],
    iconAnchor: [s / 2, s + 6],
    html:
      `<div style="position:relative;width:${s}px;height:${s + 8}px;filter:drop-shadow(0 4px 10px rgba(10,12,20,.45))">${glow}` +
      `<div style="position:absolute;inset:0 0 8px 0;border-radius:14px;background:${dim ? '#c9c7d2' : '#ffffff'};display:grid;place-items:center">` +
      `<svg width="${s * 0.55}" height="${s * 0.55}" viewBox="0 0 24 24" fill="none" stroke="${dim ? '#6b6a78' : '#14161f'}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">` +
      `<circle cx="10" cy="3.6" r="1.7"/><path d="M10 7.5v5.2h5.4l2.6 6"/><path d="M8.2 11.4a5.2 5.2 0 1 0 6.1 7.2"/><path d="M18 19.4h2.4"/></svg>` +
      `</div>` +
      `<span style="position:absolute;left:50%;bottom:8px;width:0;height:0;margin-left:-5px;border-left:5px solid transparent;border-right:5px solid transparent;border-top:8px solid ${dim ? '#c9c7d2' : '#ffffff'}"></span>` +
      (u.batt != null ? `<span style="position:absolute;top:-3px;right:-3px;width:11px;height:11px;border-radius:999px;background:${battColor(u.batt)};border:2px solid #fff"></span>` : '') +
      `</div>`,
  });
}

function arrowIcon(u: MapUnit, active: boolean) {
  const c = active ? '#ff563c' : u.status === 'rented' ? '#ff8b7a' : u.status === 'available' ? '#ffffff' : '#9b99a6';
  const s = active ? 30 : 20;
  return L.divIcon({
    className: '',
    iconSize: [s, s],
    iconAnchor: [s / 2, s / 2],
    html: `<div style="width:${s}px;height:${s}px;transform:rotate(${u.course || 0}deg);filter:drop-shadow(0 2px 6px rgba(10,12,20,.5))">` +
      `<svg viewBox="0 0 24 24" width="${s}" height="${s}"><path d="M12 2 20 21 12 16.6 4 21Z" fill="${c}" stroke="#14161f" stroke-width="1.4" stroke-linejoin="round"/></svg></div>`,
  });
}

interface Props {
  state: MapState;
  onPickUnit?: (id: string) => void;
  /** Fires when the map is clicked while state.pickPoint is on. */
  onPickPoint?: (lat: number, lng: number) => void;
}

// One rendered zone: the circle plus its name label.
interface ZoneLayer {
  circle: L.Circle;
  label: L.Marker;
  sig: string;
}

function zoneLabelIcon(name: string, color: string) {
  const safe = name.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
  return L.divIcon({
    className: '',
    iconSize: [0, 0],
    iconAnchor: [0, 0],
    html:
      `<div style="transform:translate(-50%,-50%);white-space:nowrap;padding:3px 9px;border-radius:999px;` +
      `background:${color};color:#fff;font:700 11px/1.2 var(--font-body),system-ui;` +
      `box-shadow:0 2px 8px rgba(10,12,20,.4);opacity:.94">${safe}</div>`,
  });
}

// One in-flight tween per marker. Positions arrive at ~1 Hz; easing between
// them keeps movement continuous and hides the GPS/estimated hand-over.
interface Tween {
  raf: number;
  fromLat: number;
  fromLng: number;
  toLat: number;
  toLng: number;
  start: number;
}
const TWEEN_MS = 950;

export default function FleetMap({ state, onPickUnit, onPickPoint }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<Record<string, L.Marker & { _sig?: string }>>({});
  const fenceRef = useRef<L.Polygon | null>(null);
  const trailRef = useRef<L.Polyline | null>(null);
  const meRef = useRef<L.Marker | null>(null);
  const themeRef = useRef<'dark' | 'light'>('dark');
  const tilesRef = useRef<L.TileLayer | null>(null);
  const lastFit = useRef<number | undefined>(undefined);
  const lastRecenter = useRef<number | undefined>(undefined);
  // Camera bookkeeping: what zoom the APP last asked for, which chair is
  // selected, and a chair we still owe a fly-to once its position resolves.
  const lastRequestedZoom = useRef<number | undefined>(undefined);
  const lastActiveId = useRef<string | null>(null);
  const pendingFocus = useRef<string | null>(null);
  const tweensRef = useRef<Record<string, Tween>>({});
  // Kept current in an effect rather than assigned during render, so the
  // component stays pure (marker click handlers read it later, not now).
  const pickRef = useRef(onPickUnit);
  useEffect(() => {
    pickRef.current = onPickUnit;
  }, [onPickUnit]);

  const zonesRef = useRef<Record<string, ZoneLayer>>({});
  const pickPointRef = useRef(onPickPoint);
  const pickModeRef = useRef(Boolean(state.pickPoint));
  useEffect(() => {
    pickPointRef.current = onPickPoint;
  }, [onPickPoint]);
  useEffect(() => {
    pickModeRef.current = Boolean(state.pickPoint);
  }, [state.pickPoint]);

  const tweenMarker = (id: string, marker: L.Marker, toLat: number, toLng: number) => {
    const current = marker.getLatLng();
    // Already there (within ~11 cm) — nothing to animate.
    if (Math.abs(current.lat - toLat) < 1e-6 && Math.abs(current.lng - toLng) < 1e-6) return;

    const existing = tweensRef.current[id];
    if (existing) cancelAnimationFrame(existing.raf);

    const tween: Tween = {
      raf: 0,
      fromLat: current.lat,
      fromLng: current.lng,
      toLat,
      toLng,
      start: performance.now(),
    };

    const step = (t: number) => {
      if (!mapRef.current) {
        delete tweensRef.current[id];
        return;
      }
      const p = Math.min(1, (t - tween.start) / TWEEN_MS);
      const k = p * (2 - p); // easeOutQuad
      try {
        if (marker && (marker as any)._map) {
          marker.setLatLng([
            tween.fromLat + (tween.toLat - tween.fromLat) * k,
            tween.fromLng + (tween.toLng - tween.fromLng) * k,
          ]);
        }
      } catch {
        delete tweensRef.current[id];
        return;
      }
      if (p < 1) {
        tween.raf = requestAnimationFrame(step);
      } else {
        delete tweensRef.current[id];
      }
    };

    tween.raf = requestAnimationFrame(step);
    tweensRef.current[id] = tween;
  };

  // init once
  useEffect(() => {
    if (!hostRef.current || mapRef.current) return;
    const st = state;
    const map = L.map(hostRef.current, {
      center: st.center || [21.4225, 39.8262],
      zoom: st.zoom || 16,
      zoomControl: false,
      attributionControl: true,
      // Continuous zoom rather than whole steps: wheel and pinch feel smooth
      // instead of jumping a level at a time.
      zoomSnap: 0,
      zoomDelta: 0.6,
      wheelPxPerZoomLevel: 90,
      zoomAnimation: true,
    });

    // Explicit +/- buttons. Without these the map could only be zoomed by
    // wheel or pinch, which is awkward on a laptop trackpad and impossible
    // to discover.
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    themeRef.current = st.theme === 'light' ? 'light' : 'dark';
    tilesRef.current = L.tileLayer(TILES[themeRef.current], { attribution: ATTR, maxZoom: 20, subdomains: 'abcd' }).addTo(map);
    fenceRef.current = L.polygon([], { color: '#ff563c', weight: 2, opacity: 0.85, dashArray: '2 7', lineCap: 'round', fillColor: '#ff563c', fillOpacity: 0.05 }).addTo(map);
    trailRef.current = L.polyline([], { color: '#ff563c', weight: 4, opacity: 0.8, lineCap: 'round' }).addTo(map);
    // Placing a zone: report the clicked coordinate to the console.
    map.on('click', (e: L.LeafletMouseEvent) => {
      if (!pickModeRef.current) return;
      pickPointRef.current?.(e.latlng.lat, e.latlng.lng);
    });

    mapRef.current = map;
    // React StrictMode double-mounts effects in dev: any deferred call must
    // check the map is still alive, or Leaflet throws on `_leaflet_pos`.
    let disposed = false;
    const safeInvalidate = () => { if (!disposed) map.invalidateSize(); };
    const sizeTimer = setTimeout(safeInvalidate, 120);
    const ro = new ResizeObserver(safeInvalidate);
    ro.observe(hostRef.current);
    return () => {
      disposed = true;
      clearTimeout(sizeTimer);
      ro.disconnect();
      // Kill in-flight tweens before the markers they drive are detached.
      Object.values(tweensRef.current).forEach((t) => cancelAnimationFrame(t.raf));
      tweensRef.current = {};
      Object.values(markersRef.current).forEach((m) => m.remove());
      markersRef.current = {};
      Object.values(zonesRef.current).forEach((z) => {
        z.circle.remove();
        z.label.remove();
      });
      zonesRef.current = {};
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // apply on every state change
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const st = state;
    const want: 'dark' | 'light' = st.theme === 'light' ? 'light' : 'dark';
    if (want !== themeRef.current) { themeRef.current = want; tilesRef.current?.setUrl(TILES[want]); }

    if (fenceRef.current) {
      if (st.fence && st.fence.length) fenceRef.current.setLatLngs(st.fence);
      fenceRef.current.setStyle({
        color: st.breach ? '#ff563c' : want === 'dark' ? '#8f96ff' : '#5b62d8',
        fillOpacity: st.breach ? 0.1 : 0.05,
        weight: st.breach ? 3 : 2,
      });
    }
    trailRef.current?.setLatLngs(st.trail && st.trail.length ? st.trail : []);

    // ---- named geofence zones -------------------------------------------
    // Reconciled by id so panning/zooming never rebuilds them, and only the
    // properties that actually changed are re-applied.
    const wantZones = st.zones ?? [];
    const seenZones: Record<string, 1> = {};
    for (const z of wantZones) {
      seenZones[z.id] = 1;
      const sig = [z.lat, z.lng, z.radiusM, z.color, z.name, z.editing ? 1 : 0].join('|');
      const existing = zonesRef.current[z.id];
      if (!existing) {
        const circle = L.circle([z.lat, z.lng], {
          radius: z.radiusM,
          color: z.color,
          fillColor: z.color,
          fillOpacity: z.editing ? 0.16 : 0.07,
          weight: z.editing ? 3 : 2,
          dashArray: z.editing ? undefined : '4 6',
          interactive: false,
        }).addTo(map);
        const label = L.marker([z.lat, z.lng], {
          icon: zoneLabelIcon(z.name, z.color),
          interactive: false,
          keyboard: false,
          zIndexOffset: -200,
        }).addTo(map);
        zonesRef.current[z.id] = { circle, label, sig };
      } else if (existing.sig !== sig) {
        existing.circle.setLatLng([z.lat, z.lng]);
        existing.circle.setRadius(z.radiusM);
        existing.circle.setStyle({
          color: z.color,
          fillColor: z.color,
          fillOpacity: z.editing ? 0.16 : 0.07,
          weight: z.editing ? 3 : 2,
          dashArray: z.editing ? undefined : '4 6',
        });
        existing.label.setLatLng([z.lat, z.lng]);
        existing.label.setIcon(zoneLabelIcon(z.name, z.color));
        existing.sig = sig;
      }
    }
    for (const id of Object.keys(zonesRef.current)) {
      if (!seenZones[id]) {
        zonesRef.current[id].circle.remove();
        zonesRef.current[id].label.remove();
        delete zonesRef.current[id];
      }
    }

    if (st.me) {
      if (!meRef.current) {
        meRef.current = L.marker(st.me, {
          interactive: false,
          zIndexOffset: 500,
          icon: L.divIcon({
            className: '', iconSize: [22, 22], iconAnchor: [11, 11],
            html: '<div style="position:relative;width:22px;height:22px">' +
              '<span style="position:absolute;inset:-13px;border-radius:999px;background:#3d7bfd;opacity:.18;animation:fm-ping 2.4s ease-out infinite"></span>' +
              '<span style="position:absolute;inset:0;border-radius:999px;background:#3d7bfd;border:3px solid #fff;box-shadow:0 2px 8px rgba(10,12,20,.4)"></span></div>',
          }),
        }).addTo(map);
      } else meRef.current.setLatLng(st.me);
    }

    const seen: Record<string, 1> = {};
    const style = st.markerStyle === 'arrow' ? arrowIcon : pinIcon;
    (st.units || []).forEach((u) => {
      seen[u.id] = 1;
      const active = u.id === st.activeId;
      const sig = [u.course | 0, active ? 1 : 0, u.status, u.batt, st.markerStyle].join('|');
      let m = markersRef.current[u.id];
      if (!m) {
        m = L.marker([u.lat, u.lng], { icon: style(u, active), zIndexOffset: active ? 900 : 0, keyboard: false, riseOnHover: true }) as L.Marker & { _sig?: string };
        m.on('click', () => pickRef.current?.(u.id));
        m._sig = sig;
        m.addTo(map);
        markersRef.current[u.id] = m;
      } else {
        // Glide to the new position instead of teleporting. Telemetry lands at
        // ~1 Hz, so an instant setLatLng reads as a stutter; this also makes
        // the GPS <-> estimated hand-over look like ordinary movement.
        tweenMarker(u.id, m, u.lat, u.lng);
        if (m._sig !== sig) { m.setIcon(style(u, active)); m.setZIndexOffset(active ? 900 : 0); m._sig = sig; }
      }
    });
    Object.keys(markersRef.current).forEach((id) => {
      if (!seen[id]) {
        const t = tweensRef.current[id];
        if (t) { cancelAnimationFrame(t.raf); delete tweensRef.current[id]; }
        markersRef.current[id].remove();
        delete markersRef.current[id];
      }
    });

    // ---- camera ---------------------------------------------------------
    // Two rules, both learned the hard way:
    //
    // 1. The user's zoom is theirs. `st.zoom` is applied only when the APP
    //    asks for a *different* zoom than it last asked for — never because
    //    the map has drifted away from it. The old code compared st.zoom to
    //    the live zoom on every pass, so a constant `zoom: 16` yanked the
    //    view back out one second after any manual zoom-in.
    //
    // 2. Focusing a chair uses that chair's OWN marker position, retried
    //    until it exists, rather than the `center` prop. Center is derived
    //    from smoothed positions that land a tick later, so flying to it on
    //    the click render aimed at the previously-selected chair — which is
    //    why it took several clicks to land on the right one.
    if (st.zoom != null && st.zoom !== lastRequestedZoom.current) {
      lastRequestedZoom.current = st.zoom;
      if (Math.abs(st.zoom - map.getZoom()) > 0.01) map.setZoom(st.zoom, { animate: true });
    }

    const activeId = st.activeId ?? null;
    if (activeId !== lastActiveId.current) {
      lastActiveId.current = activeId;
      pendingFocus.current = activeId;
    }

    let moved = false;

    if (st.fit && st.fit !== lastFit.current) {
      lastFit.current = st.fit;
      pendingFocus.current = null;
      if (st.fence && st.fence.length) {
        map.flyToBounds(L.latLngBounds(st.fence).pad(0.06), { duration: 0.6 });
        moved = true;
      }
    } else if (st.recenter && st.recenter !== lastRecenter.current) {
      lastRecenter.current = st.recenter;
      // Re-arm the focus; the block below flies immediately when the chair's
      // position is already known, and otherwise waits for it.
      pendingFocus.current = activeId;
      if (!activeId && st.center) {
        map.flyTo(st.center, map.getZoom(), { duration: 0.6 });
        moved = true;
      }
    }

    if (!moved && pendingFocus.current) {
      const target = (st.units ?? []).find((x) => x.id === pendingFocus.current);
      if (target) {
        pendingFocus.current = null;
        // Keep the user's current zoom — focusing is a pan, not a zoom reset.
        map.flyTo([target.lat, target.lng], map.getZoom(), { duration: 0.6 });
        moved = true;
      }
    }

    if (!moved && st.follow && st.center) {
      const c = map.getCenter();
      if (Math.abs(c.lat - st.center[0]) > 0.0004 || Math.abs(c.lng - st.center[1]) > 0.0004) {
        map.panTo(st.center, { animate: true, duration: 1 });
      }
    }
  }, [state]);

  return <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />;
}
