#pragma once
#include <Arduino.h>

// WiFi credential provisioning via a captive-style AP config portal.
//
// Behavior:
//  - Credentials are stored in NVS flash (Preferences), so they survive power cycles.
//  - loadSavedWiFiCreds() pulls saved SSID/PASS (falls back to config.h defaults if none).
//  - startConfigPortal() brings up an open AP "WheelchairSetup" with a tiny web page at
//    http://192.168.4.1 that accepts an SSID + password, saves them to NVS, and returns.
//  - The network task decides WHEN to open the portal (after repeated connect failures).

// Load saved creds from NVS into the provided buffers.
// Returns true if creds were found in NVS, false if it fell back to config.h defaults.
bool loadSavedWiFiCreds(String &ssid, String &pass);

// Persist new creds to NVS.
void saveWiFiCreds(const String &ssid, const String &pass);

// Remove only the NVS-saved WiFi credentials once for a caller-provided
// reset token. This makes the device fall back to config.h defaults without
// erasing unrelated NVS state.
bool resetSavedWiFiCredsOnce(const char *resetToken);

// Blocking AP config portal. Runs until the user submits credentials (or timeoutMs elapses,
// if timeoutMs > 0). On submit: saves creds to NVS and returns true. On timeout: returns false.
// While open, it does NOT touch sensors/safety — those keep running on their own tasks.
bool startConfigPortal(uint32_t timeoutMs = 0);

// True while the AP config portal is currently open (uploads should pause).
bool isPortalActive();
