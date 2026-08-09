// ===========================================================================
//  config.h — single source of firmware configuration
//  Pins come from HARDWARE.md §2. Thresholds from FEATURES.md config table.
//  DO NOT commit real secrets — fill these at flash time / from a private header.
// ===========================================================================
#pragma once

// ------------------------- Identity -------------------------
#ifndef DEVICE_ID
#define DEVICE_ID          "WCHAIR-004"
#endif
// Version scheme restarted at 1.x. Kept three-part on purpose: chairs still
// running older firmware parse the target version with a strict %d.%d.%d
// reader, and a two-part string there is unparseable — which reads as
// "not newer" and silently refuses the OTA.
#define FW_VERSION         "1.3.5"

// ------------------------- WiFi & Supabase Credentials -------
#if __has_include("private_config.h")
#include "private_config.h"
#else
// No private_config.h present. Placeholders so the tree still compiles for
// inspection — not working credentials. Copy private_config.example.h.
#define WIFI_SSID          "YOUR_WIFI_SSID"
#define WIFI_PASS          "YOUR_WIFI_PASSWORD"
#define SUPABASE_URL       "https://YOUR-PROJECT.supabase.co"
#define SUPABASE_ANON_KEY  "your-anon-public-key"
#endif

#define INGEST_PATH        "/functions/v1/ingest"      // POST telemetry/events
#define COMMANDS_PATH      "/functions/v1/commands"    // POST ack; simulator also GETs pending
#define TELEMETRY_IDLE_MS   1000
#define TELEMETRY_ACTIVE_MS 250
#define TELEMETRY_OTA_MS    2000
#define TELEMETRY_LOOP_MS   25

// ------------------------- Reliability ----------------------
#define TASK_WATCHDOG_TIMEOUT_S       12
#define IMU_STALE_TIMEOUT_MS          500
#define TEMP_STALE_TIMEOUT_MS         5000
#define SENSOR_STARTUP_GRACE_MS       8000
#define CONTROLLED_STOP_CONFIRM_MS    1500
#define CONTROLLED_STOP_ALERT_MS      15000
#define STATIONARY_SPEED_KMH          0.5f
#define MOTION_ACCEL_DELTA_MPS2       0.22f
#define MOTION_GYRO_RATE_DPS          10.0f
#define MOTION_CONFIRM_SAMPLES        3
#define MOTION_HOLD_MS                3000

// ------------------------- GPS (NEO-M8N, UART1) --------------
#ifdef GPS_RX_PIN_OVERRIDE
#define GPS_RX_PIN         GPS_RX_PIN_OVERRIDE
#else
#define GPS_RX_PIN         17   // <- ESP32 RX (Switched to GPIO 17)
#endif

#ifdef GPS_TX_PIN_OVERRIDE
#define GPS_TX_PIN         GPS_TX_PIN_OVERRIDE
#else
#define GPS_TX_PIN         18   // -> ESP32 TX (Switched to GPIO 18)
#endif
#ifdef GPS_BAUD_OVERRIDE
#define GPS_BAUD           GPS_BAUD_OVERRIDE
#else
#define GPS_BAUD           9600
#endif

// ------------------------- I2C (MPU6500 6-Axis IMU) -----------
#define I2C_SDA_PIN        9
#define I2C_SCL_PIN        8
#define MPU6500_ADDR       0x68
#define MPU_ACCEL_RANGE_G  4
#define MPU_GYRO_RANGE_DPS 500
#define IMU_FAILURE_LIMIT  5

// ------------------------- Temperature ----------------------
#define ONEWIRE_PIN        10   // Single DS18B20 motor temp sensor (waterproof probe)
#ifndef TEMP_SENSOR_REQUIRED
#define TEMP_SENSOR_REQUIRED 1
#endif


// Anti-tamper (MPU6500) ------------
// Shock and vibration tamper detection. Armed only while the chair is LOCKED.
// A locked/parked chair is stationary; lifting/pushing produces linear
// acceleration and rotating/tilting it produces gyro rate — either crossing
// its threshold counts as one disturbance (same 3-warn / 4th-siren escalation).
#define TAMPER_REFRACTORY_MS     2500  // min gap between counted tamper events (longer refractory)
#define TAMPER_ALARM_AT          4     // 3 warning chirps, 4th => continuous siren
#define TAMPER_MPU_ACCEL_THRESH  4.5f  // m/s^2 deviation from 1g (~0.46g) = heavy shove/lift/shake (increased from 2.5)
#define TAMPER_MPU_GYRO_THRESH   45.0f // deg/s rotation rate = rapid tilting/turning the chair (increased from 30.0)

// How long the tamper siren may sound before it mutes itself.
//
// Without this the siren runs until an operator sends CLEAR_TAMPER, which
// assumes the operator can reach the chair. If the uplink is down there is no
// way to stop it at all — and an alarm nobody can silence is its own fault.
//
// Mutes the SOUND only. The tamper latch, the disturbance count and the
// telemetry are untouched, so the console still reports the tamper and still
// requires an explicit acknowledgement. Quiet must never read as resolved.
//
// Set per-build (see platformio.ini) so it applies only to the chair asked for.
// 0 keeps the original behaviour: sound until acknowledged.
//
// No cast in here: this macro is tested with #if, and the preprocessor cannot
// evaluate `(uint32_t)` — it reduces the unknown identifier to 0 and then chokes
// on the number that follows. 1000UL keeps the arithmetic unsigned at the use
// site, which is what makes the millis() rollover comparison correct.
#ifdef TAMPER_BUZZER_TIMEOUT_S
#define TAMPER_BUZZER_TIMEOUT_MS  (TAMPER_BUZZER_TIMEOUT_S * 1000UL)
#else
#define TAMPER_BUZZER_TIMEOUT_MS  0
#endif

// ------------------------- Power sense ----------------------
#define BATT_ADC_PIN       2    // ADC1_CH1 (GPIO 2) — via divider
#define BATT_DIVIDER       11.0f
#define BATT_MIN_VALID_V   18.0f
#define BATT_MAX_VALID_V   32.0f
#define BATT_EMPTY_V       21.0f
#define BATT_FULL_V        29.4f
// Explicitly retained for the current prototype hardware. A production pilot
// must set this to 0 and provide a verified battery measurement/BMS feed.
#define ALLOW_BATTERY_DISPLAY_FALLBACK 1
#define ALLOW_UNVERIFIED_BATTERY_FOR_OTA 1

// ------------------------- Actuators ------------------------
#define RELAY_MOTION_PIN   13   // CH2 — motion lock
#define RELAY_ACTIVE_LOW   1    // most modules are active-low
#define BUZZER_PIN         1    // Piezo Buzzer
#define BUZZER_ACTIVE_LOW  0    // 0 = active-high, 1 = active-low
#define STATUS_LED_PIN     21   // Onboard status LED

// ---------------- Emergency wheel unlock (separate relay) ----------------
// A SECOND relay, distinct from RELAY_MOTION_PIN above. The motion lock gates
// whether the chair may *drive*; this one cuts power to the electromagnetic
// wheel brake so the wheels physically free-wheel and the chair can be pushed
// by hand — the manual escape route when a chair is stuck, immobilised in a
// fault, or blocking a doorway.
//
// Defined ONLY by the build that has the hardware (see platformio.ini). On
// every other chair nothing below exists, so no pin is claimed and no
// behaviour changes.
#ifdef WHEEL_UNLOCK_RELAY_PIN
#define HAS_WHEEL_UNLOCK        1
#define RELAY_WHEEL_UNLOCK_PIN  WHEEL_UNLOCK_RELAY_PIN

// 0 = the ESP32 pin drives the relay through an NPN, HIGH energizes the coil.
//
// The fitted module is a 1-channel Songle SRD-05VDC-SL-C with a plain
// VCC / GND / IN header — no JD-VCC pin, no jumper. Its input stage is
// referenced to the module's own 5V rail and conducts whenever IN is pulled
// down, so it needs IN within about a volt of 5V to switch OFF. A 3.3V logic
// high leaves ~1.7V across it, which is not enough: the coil stays energized
// permanently and NO value of this flag can switch it.
//
// That was established by measurement, not inference. GPIO 41 swung a clean
// 3.33V/0.12V and the coil rail measured a healthy 5V, yet the relay latched on
// under BOTH settings of this flag — 1 (idle 3.33V) and 0 (idle 0.12V). Two
// different levels producing the identical output is only possible if the input
// cannot be turned off at all, which is what separates a level-compatibility
// fault from the polarity fault it was first mistaken for.
//
// REQUIRED INTERFACE — this module cannot be driven from GPIO 41 directly:
//
//     GPIO 41 --[ 1k ]-- B
//                          NPN (BC547 / 2N2222 / S8050)
//                GND ----- E
//          module IN ----- C
//
//     module VCC -> 5V,  module GND -> GND (common with the ESP32)
//
// The transistor gives IN a hard pull to ~0.2V that the input stage will follow,
// and releases it entirely when off. It also INVERTS the sense: a HIGH from the
// ESP32 energises the coil.
//
// FLIPPED TO 1 at the operator's request: with 0 the console's unlock LOCKED the
// chair and lock UNLOCKED it, observed on the fitted hardware.
//
// What that inversion means physically. With 0, "release" drives HIGH, which
// through the NPN energises the coil. If energising the coil ENGAGES the brake,
// the brake feed is on the relay's NO contact rather than NC.
//
// Worth knowing, because it moves where the failure lands: on NO, a
// de-energised coil means the brake is unpowered, so a dead MCU, a crashed task
// or a lost 5V rail leaves the wheels FREE. Moving the brake feed from NO to NC
// would correct the direction in hardware and restore the fail-safe, and this
// flag would go back to 0. Until then the console reads correctly but the
// resting-on-failure state does not, and an external 10k pull-UP from GPIO 41 to
// 3V3 is the useful mitigation — it holds "engaged" through reset, before
// initActuators() runs.
#ifndef WHEEL_UNLOCK_ACTIVE_LOW
#define WHEEL_UNLOCK_ACTIVE_LOW 1
#endif

// The timer was removed at the operator's request: the release now LATCHES and
// only an explicit re-engage ends it. It is still held in RAM only and never
// persisted, so a reboot comes back braked — an unattended chair that restarts
// must not come back free-wheeling.
#else
#define HAS_WHEEL_UNLOCK        0
#endif

// ---------------- Emergency power cut (third relay) ----------------------
// Cuts the wheelchair's main power. A THIRD relay, independent of both the
// motion lock (GPIO 13) and the wheel brake, and defined only by the build that
// has it fitted — every other chair compiles with no reference to the pin.
//
// Deliberately NOT time-boxed, unlike the wheel unlock. Free-wheeling is a
// hazard, so that one expires by itself; a power cut is the SAFE state, and a
// timer that silently restored power would undo an operator's deliberate
// decision. So this latches, survives reboot via NVS, and only an explicit
// operator command turns it back on.
//
// *** THE ESP32 MUST BE POWERED UPSTREAM OF THIS RELAY ***
// If the ESP32 sits downstream, cutting power kills the ESP32, which
// de-energises the coil, which restores power, which reboots the ESP32 — a
// self-oscillating loop, and no way to ever command power back on. Wire the
// board's supply before the relay, or from a separate feed.
#ifdef POWER_RELAY_PIN
#define HAS_POWER_RELAY         1
#define RELAY_POWER_PIN         POWER_RELAY_PIN

// Same module family and the same NPN interface as the wheel-unlock relay, so
// the same sense: 0 => a HIGH from the ESP32 energises the coil.
//
// Power flows through the relay's NC contact, so de-energised = powered. That
// makes the reset state safe in the only direction that matters here: GPIO 39
// floats low from reset, the coil stays de-energised, and the chair keeps its
// power rather than the board cutting the chair off by failing.
#ifndef POWER_RELAY_ACTIVE_LOW
#define POWER_RELAY_ACTIVE_LOW  0
#endif
#else
#define HAS_POWER_RELAY         0
#endif


// ------------------------- Thresholds (FEATURES.md) ---------
#define TEMP_HOT_C         55.0f
#define TEMP_HYSTERESIS_C  5.0f
// Operator maintenance override (degraded-mode running with a failed sensor).
#define MAINT_OVERRIDE_DEFAULT_MIN  15
#define MAINT_OVERRIDE_MAX_MIN      120

#define TILT_WARN_DEG      30.0f
#define TILT_FALL_DEG      50.0f
#define FALL_CONFIRM_MS    750
#define GEOFENCE_RADIUS_M  300.0f
#define GEOFENCE_HYSTERESIS_M 10.0f
#define GEOFENCE_CONFIRM_FIXES 3
#define GPS_FIX_TIMEOUT_MS 2000
#define GPS_MIN_FIX_SATELLITES 4
#define GPS_MAX_FIX_HDOP   8.0f

// How long the receiver may go silent before its last sentences are discarded
// rather than kept on reporting. A healthy module emits GGA/RMC at 1 Hz even
// with no satellites, so several seconds of nothing means the module itself is
// gone — unplugged, unpowered, or a broken RX line — not merely unfixed.
#define GPS_DATA_STALE_MS  6000UL
#define EXPIRY_WARN_S      120
#define OFFLINE_AFTER_S    30   // cloud marks device offline if no telemetry within this window

// ------------------------- Transport / OTA ------------------
// Bounds how long ONE request can hold the shared TLS client, and therefore
// the worst-case gap in the telemetry heartbeat. At 7000 a single stalled POST
// blocked the 1 Hz uplink long enough for the console to call a healthy chair
// disconnected; a small JSON POST that has not answered in 4s is not going to.
#define HTTPS_TIMEOUT_MS          4000
#define OTA_VALIDATION_TIMEOUT_MS 90000
#define OTA_MIN_BATTERY_PCT       30
#define OTA_REQUIRE_SHA256        1
#define OTA_EVENT_FLUSH_MS        5000
