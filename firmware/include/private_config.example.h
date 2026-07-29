#pragma once
// ===========================================================================
//  Copy this file to private_config.h and fill in the real values.
//
//  private_config.h is gitignored and must stay that way. DEVICE_KEY is the
//  HMAC secret the ingest Edge Function verifies every packet against — anyone
//  holding it can forge telemetry for that chair, so it never belongs in a
//  repository, and least of all a public one.
// ===========================================================================

// Bench / site WiFi.
#define WIFI_SSID          "YOUR_WIFI_SSID"
#define WIFI_PASS          "YOUR_WIFI_PASSWORD"

// Supabase project the fleet reports to.
#define SUPABASE_URL       "https://YOUR-PROJECT.supabase.co"

// Per-chair HMAC key. Must match public.wheelchairs.device_key for the
// DEVICE_ID set in config.h, or the ingest function rejects every upload with
// "Invalid HMAC signature" — the chair keeps transmitting and simply
// disappears from the fleet, with no error visible on the device itself.
//
// The guard lets platformio.ini override it for a per-chair build env.
#ifndef DEVICE_KEY
#define DEVICE_KEY         "SECURE_SECRET_KEY_FOR_CHAIR_X"
#endif
