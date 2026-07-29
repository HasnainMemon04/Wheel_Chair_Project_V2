#include "actuators.h"
#include "sensors.h"
#include "network.h"
#include "config.h"
#include <esp_task_wdt.h>

// Track relay states locally
static bool motionRelayState = true;  // opposite default to trigger boot log

// Safety supervisor latches (file scope so applyActuatorStates can read them)
static bool overtempLatched = false;
static bool overtempReported = false;
static bool fallLatched = false;
static bool fallReported = false;
static int fallBreachTicks = 0;

// Sensor Fault latches
static bool sensorFaultLatched = false;

// --------------------------------------------------------------------------
// Maintenance override.
//
// A failed or unplugged safety sensor otherwise strands a chair forever: the
// interlock only releases when the sensor reports healthy again, so a broken
// probe means a chair nobody can recover remotely. A fleet operator can grant
// a TIME-LIMITED override that suppresses the *missing sensor* interlock.
//
// It deliberately cannot override a hazard the device can actually measure
// (real over-temperature, or a chair currently past its fall angle) — those
// are evidence, not absence of evidence. That check lives in
// requestMaintenanceOverride() so the DEVICE, not the browser, decides.
// --------------------------------------------------------------------------
static bool sensorFaultReported = false;
static uint32_t maintenanceOverrideUntilMs = 0;

static bool maintenanceOverrideActive() {
    return maintenanceOverrideUntilMs != 0 && millis() < maintenanceOverrideUntilMs;
}

uint32_t maintenanceOverrideRemainingS() {
    if (!maintenanceOverrideActive()) return 0;
    return (maintenanceOverrideUntilMs - millis()) / 1000;
}

bool requestMaintenanceOverride(uint32_t minutes, String &refusalReason) {
    if (minutes == 0 || minutes > MAINT_OVERRIDE_MAX_MIN) {
        minutes = MAINT_OVERRIDE_DEFAULT_MIN;
    }

    float tempBatt = NAN;
    float tilt = NAN;
    xSemaphoreTake(stateMutex, portMAX_DELAY);
    tempBatt = sharedTelemetry.temp_battery;
    tilt = sharedTelemetry.tilt;
    xSemaphoreGive(stateMutex);

    // Measured over-temperature is a real hazard — never overridable.
    if (!isnan(tempBatt) && tempBatt > TEMP_HOT_C) {
        refusalReason = "measured over-temperature";
        return false;
    }
    // A chair still past its fall angle is a real hazard — never overridable.
    if (!isnan(tilt) && tilt > TILT_FALL_DEG) {
        refusalReason = "chair is still tipped over";
        return false;
    }

    maintenanceOverrideUntilMs = millis() + minutes * 60UL * 1000UL;
    sensorFaultLatched = false;
    sensorFaultReported = false;
    buzzerWrite(false);
    Serial.printf(
        "[Safety] MAINTENANCE OVERRIDE granted for %u min. Degraded-mode operation.\n",
        minutes
    );
    return true;
}

void cancelMaintenanceOverride() {
    if (maintenanceOverrideUntilMs != 0) {
        maintenanceOverrideUntilMs = 0;
        Serial.println("[Safety] Maintenance override cancelled — normal interlocks restored.");
    }
}

// Manual SOS latches
static bool manualSOSLatched = false;
static bool manualSOSReported = false;

// Warnings and events latches
static bool tiltWarnLatched = false;
static bool geofenceExitLatched = false;

static portMUX_TYPE controlledStopMux = portMUX_INITIALIZER_UNLOCKED;
static bool controlledStopPending = false;
static bool controlledStopPowerOff = false;
static uint32_t controlledStopRequestedAtMs = 0;

// Anti-tamper detection (SW-520D edge counting). Armed only while LOCKED.
// 3 disturbances => warning chirps; the 4th latches a continuous siren until
// an operator/rider sends CLEAR_TAMPER (or the chair is unlocked/rented).
static int  tamperWarnCount = 0;
static bool tamperAlarmLatched = false;
static bool tamperReported = false;
static bool tamperArmed = false;
static unsigned long lastTamperEventMs = 0;

// ---- Alarm silencing -------------------------------------------------------
// Silencing is NOT the same as clearing. CLEAR_SOS releases every latch — the
// fall, the over-temp, the tamper — and with them the motion interlock. An
// operator who only wants the siren to stop should not have to release the
// safety cut on a chair that may still be lying on its side, so the two are
// separate: this mutes the sound and changes nothing else.
static bool alarmSilenced = false;
static uint8_t silencedCauses = 0;

// Bitmask of what is currently sounding, so a NEW hazard can re-arm the siren
// even while an earlier one is muted.
static uint8_t activeAlarmCauses() {
    return (uint8_t)((fallLatched ? 0x1 : 0)
                   | (manualSOSLatched ? 0x2 : 0)
                   | (overtempLatched ? 0x4 : 0)
                   | (tamperAlarmLatched ? 0x8 : 0));
}

void initActuators() {
    pinMode(RELAY_MOTION_PIN, OUTPUT);
    pinMode(BUZZER_PIN, OUTPUT);
    pinMode(STATUS_LED_PIN, OUTPUT);
    
    // Set default fail-safe state: Motion LOCKED
    setMotionRelay(false);
    
    // Simple startup buzzes
    buzzerChirp(2, 80);
}


void setMotionRelay(bool allowMotion) {
    if (motionRelayState == allowMotion) return; // Don't write or log if already in this state
    motionRelayState = allowMotion;
    bool pinValue = allowMotion;
    if (RELAY_ACTIVE_LOW) {
        pinValue = !allowMotion;
    }
    digitalWrite(RELAY_MOTION_PIN, pinValue ? HIGH : LOW);
    Serial.printf("[Relay] MOTION set to %s (pin write)\n", allowMotion ? "ALLOW" : "LOCKED");
}

void buzzerWrite(bool on) {
    bool pinValue = on;
    if (BUZZER_ACTIVE_LOW) {
        pinValue = !on;
    }
    digitalWrite(BUZZER_PIN, pinValue ? HIGH : LOW);
}


void buzzerChirp(int count, int delayMs) {
    for (int i = 0; i < count; i++) {
        buzzerWrite(true);
        delay(delayMs);
        buzzerWrite(false);
        if (i < count - 1) {
            delay(delayMs);
        }
    }
}

void buzzerAlarm(bool active) {
    buzzerWrite(active);
}

void updateRGBLED(uint8_t r, uint8_t g, uint8_t b) {
    digitalWrite(STATUS_LED_PIN, (r > 0 || g > 0 || b > 0) ? HIGH : LOW);
}

void requestControlledStop(bool powerOffAfterStop) {
    portENTER_CRITICAL(&controlledStopMux);
    controlledStopPending = true;
    controlledStopPowerOff = controlledStopPowerOff || powerOffAfterStop;
    controlledStopRequestedAtMs = millis();
    portEXIT_CRITICAL(&controlledStopMux);
}

void cancelControlledStop() {
    portENTER_CRITICAL(&controlledStopMux);
    controlledStopPending = false;
    controlledStopPowerOff = false;
    controlledStopRequestedAtMs = 0;
    portEXIT_CRITICAL(&controlledStopMux);
}

bool isControlledStopPending() {
    portENTER_CRITICAL(&controlledStopMux);
    const bool pending = controlledStopPending;
    portEXIT_CRITICAL(&controlledStopMux);
    return pending;
}

// Immediate Actuation Trigger (called directly by processCommands on Core 0)
void applyActuatorStates() {
    xSemaphoreTake(stateMutex, portMAX_DELAY);
    bool power = sharedTelemetry.power_state;
    bool locked = sharedTelemetry.locked_state;
    bool inMotion = sharedTelemetry.in_motion;
    xSemaphoreGive(stateMutex);

    bool safetyInterlockActive = (overtempLatched || fallLatched || manualSOSLatched || sensorFaultLatched);

    const bool immediateEmergency = fallLatched || manualSOSLatched;
    if (safetyInterlockActive) {
        setMotionRelay(!immediateEmergency && inMotion);
    } else if (isControlledStopPending() && inMotion) {
        setMotionRelay(true);
    } else {
        setMotionRelay(power && !locked);
    }
}


// Manual SOS API controls
void triggerManualSOS() {
    manualSOSLatched = true;
}

void clearManualSOS() {
    manualSOSLatched = false;
    manualSOSReported = false;
    fallLatched = false;
    fallReported = false;
    fallBreachTicks = 0;
    overtempLatched = false;
    overtempReported = false;
    tamperAlarmLatched = false;
    tamperWarnCount = 0;
    tamperReported = false;
    alarmSilenced = false;
    silencedCauses = 0;
    buzzerWrite(false);
    updateRGBLED(0, 255, 0);
    Serial.println("[Safety] ALL Emergency Latches Cleared by Operator Command. Buzzer SILENCED.");
}

bool isManualSOSActive() {
    return manualSOSLatched;
}

/**
 * Mute the siren while leaving every latch — and the motion cut — in place.
 *
 * Refuses when nothing is sounding, so the console never reports "silenced" for
 * a chair that was already quiet. The mute is tied to the specific hazards
 * sounding right now: if a different one appears afterwards the siren returns
 * on its own, because muting a fall must not also mute a later tamper.
 */
bool silenceAlarm(String &resultMessage) {
    const uint8_t causes = activeAlarmCauses();
    if (causes == 0) {
        resultMessage = "Nothing is sounding on this chair.";
        return false;
    }
    alarmSilenced = true;
    silencedCauses = causes;
    buzzerWrite(false);
    Serial.printf("[Safety] Alarm SILENCED by operator (causes 0x%02X). Interlocks remain engaged.\n", causes);
    resultMessage = "Alarm silenced. The chair stays locked out until the hazard clears.";
    return true;
}

bool isAlarmSilenced() {
    return alarmSilenced;
}

// Anti-tamper acknowledgement (CLEAR_TAMPER command from operator/rider).
// Silences the siren, resets the warning count, and re-arms cleanly.
void clearTamper() {
    tamperAlarmLatched = false;
    tamperWarnCount = 0;
    tamperReported = false;
    buzzerWrite(false);
    Serial.println("[Tamper] Cleared by operator/rider acknowledgment. Re-armed.");
}

// Safety Supervisor Task running at 20 Hz
void safetySupervisorTask(void *pvParameters) {
    esp_task_wdt_add(NULL);
    TickType_t lastWakeTime = xTaskGetTickCount();
    Serial.println("[Tasks] Safety Supervisor Task started.");

    uint32_t loopTicks = 0;
    int buzzerBeepTicks = 0;
    uint32_t stationarySinceMs = 0;
    bool controlledStopAlertReported = false;

    while (true) {
        esp_task_wdt_reset();
        loopTicks++;

        // Handle non-blocking buzzer warning beeps decrement
        if (buzzerBeepTicks > 0) {
            buzzerBeepTicks--;
        }

        // Read shared state values
        xSemaphoreTake(stateMutex, portMAX_DELAY);
        float tempBatt = sharedTelemetry.temp_battery;
        float tilt = sharedTelemetry.tilt;
        bool locked = sharedTelemetry.locked_state;
        bool power = sharedTelemetry.power_state;
        String state = sharedTelemetry.session_state;
        int timeLeft = sharedTelemetry.time_left_s;
        bool inMotion = sharedTelemetry.in_motion;
        bool gpsFix = sharedTelemetry.gps_fix;
        bool vibrationActive = sharedTelemetry.vibration_state;
        bool insideGf = sharedTelemetry.gf.inside;
        float gfDist = sharedTelemetry.gf.dist_m;
        float gfRadius = sharedTelemetry.gf.radius_m;
        bool gfOn = sharedTelemetry.gf.on;
        xSemaphoreGive(stateMutex);

        // Snapshot what this task observed. At the write-back boundary, only a
        // value changed by another task should override local state-machine work.
        const bool observedLocked = locked;
        const bool observedPower = power;
        const String observedState = state;
        const int observedTimeLeft = timeLeft;

        // 1. SENSOR FAULT Check (critical IMU or temperature input stale).
        //    An operator-granted maintenance override suppresses this specific
        //    interlock so a dead probe cannot strand the chair. It expires on
        //    its own; measured hazards are never suppressed (see
        //    requestMaintenanceOverride).
        const bool overrideActive = maintenanceOverrideActive();
        static bool overrideWasActive = false;
        if (overrideWasActive && !overrideActive) {
            Serial.println("[Safety] Maintenance override EXPIRED — normal interlocks restored.");
            reportSafetyEvent("MAINT_OVERRIDE_EXPIRED", "{}");
        }
        overrideWasActive = overrideActive;

        const bool safetySensorsHealthy = areSafetySensorsHealthy();
        const bool sensorMonitoringReady =
            millis() >= SENSOR_STARTUP_GRACE_MS;
        if (sensorMonitoringReady && !safetySensorsHealthy && !overrideActive) {
            if (!sensorFaultLatched) {
                sensorFaultLatched = true;
                Serial.println("[Safety] Critical IMU/temperature sensor unavailable or stale.");
            }
        }
        if (sensorFaultLatched) {
            if (safetySensorsHealthy) {
                sensorFaultLatched = false;
                sensorFaultReported = false;
                Serial.println("[Safety] SENSOR FAULT Cleared. Sensor readings restored.");
                reportSafetyEvent("SENSOR_RECOVERED", "{}");
            } else if (overrideActive) {
                sensorFaultLatched = false;
                sensorFaultReported = false;
            }
        }

        // 2. OVERTEMP Interlock Check (Battery > 70 C)
        // If there is a sensor fault, we treat it as a critical failure (handled by sensorFaultLatched above)
        // We only check temperature thresholds if the sensor readings are valid (not NaN).
        if (!isnan(tempBatt)) {
            if (tempBatt > TEMP_HOT_C) {
                if (!overtempLatched) {
                    overtempLatched = true;
                    Serial.printf("[Safety] OVERTEMP Breached! Batt: %.1f C\n", tempBatt);
                }
            }
            // Hysteresis release: Only clear when it falls below (70 C - 8 C) = 62 C
            if (overtempLatched) {
                if (tempBatt < (TEMP_HOT_C - TEMP_HYSTERESIS_C)) {
                    overtempLatched = false;
                    overtempReported = false;
                    Serial.println("[Safety] OVERTEMP Cleared. Hysteresis band reset.");
                    reportSafetyEvent(
                        "OVERTEMP_CLEARED",
                        "{\"temp_batt\":" + String(tempBatt) + "}"
                    );
                }
            }
        }

        // 2. FALL Interlock Check (MPU6500 tilt beyond TILT_FALL_DEG, sustained
        //    for FALL_CONFIRM_MS). NaN tilt is handled by the sensor-fault path.
        bool fallBreached = false;
        if (!isnan(tilt) && tilt > TILT_FALL_DEG) {
            fallBreachTicks++;
            if (fallBreachTicks * 50 >= FALL_CONFIRM_MS) {
                fallBreached = true;
            }
        } else {
            fallBreachTicks = 0;
        }

        if (fallBreached && !fallLatched) {
            fallLatched = true;
            Serial.printf("[Safety] FALL DETECTED! Tilt: %.1f deg — siren + motion cut.\n", tilt);
        }

        // Auto-reset the fall / manual-SOS latches ONLY when the hazard is
        // physically gone (chair back upright) AND an operator command has
        // already moved the session out of SAFE_FAULT.
        //
        // This block previously ran UNCONDITIONALLY on every 20 Hz tick. Since
        // session_state is only set to SAFE_FAULT further below, the guard
        // still saw "LOCKED"/"ACTIVE" and wiped fallLatched — and
        // fallBreachTicks — in the SAME iteration they were set. The result:
        // a fall could never latch, the buzzer never sounded, and no FALL
        // event ever reached the cloud, no matter how far the chair tipped.
        const bool fallHazardCleared = !isnan(tilt) && tilt < TILT_WARN_DEG;
        if ((fallLatched || manualSOSLatched)
            && fallHazardCleared
            && (state == "LOCKED" || state == "ACTIVE")) {
            fallLatched = false;
            fallReported = false;
            manualSOSLatched = false;
            manualSOSReported = false;
            fallBreachTicks = 0;
            buzzerWrite(false);
            Serial.println("[Safety] Fall/SOS latch cleared — chair upright and acknowledged.");
        }

        // 3. Evaluate active safety interlock states
        bool safetyInterlockActive =
            overtempLatched || fallLatched || manualSOSLatched || sensorFaultLatched;

        if (safetyInterlockActive) {
            state = "SAFE_FAULT";
            locked = true;

            // Report safety events to Supabase (non-blocking outside mutex)
            if (sensorFaultLatched && !sensorFaultReported) {
                sensorFaultReported = true;
                reportSafetyEvent(
                    "SENSOR_FAULT",
                    "{\"error\":\"critical_sensor_unavailable_or_stale\"}"
                );
            }
            if (overtempLatched && !overtempReported) {
                overtempReported = true;
                reportSafetyEvent("OVERTEMP", "{\"temp_batt\":" + String(tempBatt) + "}");
            }
            if (fallLatched && !fallReported) {
                fallReported = true;
                reportSafetyEvent("FALL", "{\"tilt\":" + String(tilt) + "}");
            }
            if (manualSOSLatched && !manualSOSReported) {
                manualSOSReported = true;
                reportSafetyEvent("SOS", "{\"manual\":1}");
            }
        } else {
            // Normal Operating Mode (No active interlocks)
            if (state == "SAFE_FAULT") {
                state = "LOCKED";
                locked = true;
            }
            
            // Local 1-second timer tick (runs once per second = 20 ticks)
            bool tickSecond = (loopTicks % 20 == 0);

            // ---- Anti-tamper security (MPU6500 accelerometer), armed only while LOCKED ----
            bool tamperArmedNow = (locked && state == "LOCKED");
            if (tamperArmedNow) {
                if (!tamperArmed) {
                    tamperArmed = true;
                }
                unsigned long nowMs = millis();
                bool imuTriggered = vibrationActive;

                if (!tamperAlarmLatched &&
                    imuTriggered &&
                    (nowMs - lastTamperEventMs) > TAMPER_REFRACTORY_MS) {
                    lastTamperEventMs = nowMs;
                    tamperWarnCount++;
                    if (tamperWarnCount >= TAMPER_ALARM_AT) {
                        tamperAlarmLatched = true;
                        if (!tamperReported) {
                            tamperReported = true;
                            reportSafetyEvent("TAMPER", "{\"count\":" + String(tamperWarnCount) + "}");
                        }
                        Serial.printf("[Tamper] ALARM! Disturbance %d — continuous siren. Awaiting CLEAR_TAMPER.\n", tamperWarnCount);
                    } else {
                        buzzerBeepTicks = 3;     // simple ~150ms warning chirp
                        Serial.printf("[Tamper] Warning %d/%d — locked chair disturbed.\n",
                                      tamperWarnCount, TAMPER_ALARM_AT - 1);
                    }
                }
            } else {
                tamperArmed = false;
                tamperWarnCount = 0;
                tamperAlarmLatched = false;
                tamperReported = false;
            }

            // Tilt Warning checks (MPU6050 tilt > 30 deg but <= 50 deg)
            if (!isnan(tilt) && tilt > TILT_WARN_DEG && tilt <= TILT_FALL_DEG) {
                if ((loopTicks / 5) % 2 == 0) {
                    updateRGBLED(255, 120, 0);
                } else {
                    updateRGBLED(0, 0, 0);
                }
                if (tickSecond) {
                    buzzerBeepTicks = 1;
                    if (!tiltWarnLatched) {
                        tiltWarnLatched = true;
                        reportSafetyEvent("TILT_WARN", "{\"tilt\":" + String(tilt) + "}");
                    }
                }
            } else if (isnan(tilt) || tilt < TILT_WARN_DEG - 3.0f) {
                tiltWarnLatched = false;
            }

            // Geofence enforcement locally
            if (gfOn && gpsFix && !insideGf) {
                if (!geofenceExitLatched) {
                    geofenceExitLatched = true;
                    reportSafetyEvent("GEOFENCE_EXIT", "{\"dist\":" + String(gfDist) + ",\"radius\":" + String(gfRadius) + "}");
                    Serial.println("[Safety] GEOFENCE_EXIT! Device is outside authorized boundary.");
                }
            } else if (gpsFix && insideGf && geofenceExitLatched) {
                geofenceExitLatched = false;
                reportSafetyEvent("GEOFENCE_ENTER", "{}");
                Serial.println("[Safety] GEOFENCE_ENTER. Returned to safety zone.");
            }

            // Time Limit Auto-Expiration check (Rider state only)
            if (state == "ACTIVE" || state == "EXPIRING" || state == "ENDING") {
                if (tickSecond) {
                    xSemaphoreTake(stateMutex, portMAX_DELAY);
                    if (sharedTelemetry.time_left_s > 0) {
                        sharedTelemetry.time_left_s--;
                    }
                    timeLeft = sharedTelemetry.time_left_s;
                    xSemaphoreGive(stateMutex);

                    if (timeLeft <= 0) {
                        if (state != "ENDING") {
                            state = "ENDING";
                            requestControlledStop(false);
                        }
                    } else if (timeLeft <= EXPIRY_WARN_S && state == "ACTIVE") {
                        state = "EXPIRING";
                    }
                }

                if (state == "ENDING") {
                    requestControlledStop(false);
                    state = "STOPPING";
                }
            }

            // Escalating warning chirps in EXPIRING state
            if (state == "EXPIRING" && tickSecond && timeLeft > 0) {
                bool shouldBeep = false;
                if (timeLeft > 60) {
                    shouldBeep = (timeLeft % 10 == 0);
                } else if (timeLeft > 30) {
                    shouldBeep = (timeLeft % 5 == 0);
                } else if (timeLeft > 10) {
                    shouldBeep = (timeLeft % 2 == 0);
                } else {
                    shouldBeep = true; // beep every second
                }

                if (shouldBeep) {
                    buzzerBeepTicks = 2; // 100ms warning beep
                }
            }
        }

        bool stopPending = false;
        bool powerOffAfterStop = false;
        uint32_t stopRequestedAtMs = 0;
        portENTER_CRITICAL(&controlledStopMux);
        stopPending = controlledStopPending;
        powerOffAfterStop = controlledStopPowerOff;
        stopRequestedAtMs = controlledStopRequestedAtMs;
        portEXIT_CRITICAL(&controlledStopMux);

        if (stopPending && !safetyInterlockActive) {
            state = "STOPPING";
            if (inMotion) {
                stationarySinceMs = 0;
                locked = false;
                power = true;
                if (
                    !controlledStopAlertReported
                    && millis() - stopRequestedAtMs >= CONTROLLED_STOP_ALERT_MS
                ) {
                    controlledStopAlertReported = true;
                    reportSafetyEvent(
                        "CONTROLLED_STOP_DELAYED",
                        "{\"reason\":\"motion_still_detected\"}"
                    );
                }
            } else {
                if (stationarySinceMs == 0) stationarySinceMs = millis();
                if (millis() - stationarySinceMs >= CONTROLLED_STOP_CONFIRM_MS) {
                    locked = true;
                    if (powerOffAfterStop) power = false;
                    state = "LOCKED";
                    cancelControlledStop();
                    stationarySinceMs = 0;
                    controlledStopAlertReported = false;
                    reportSafetyEvent(
                        "CONTROLLED_STOP_COMPLETE",
                        powerOffAfterStop
                            ? "{\"power_off\":true}"
                            : "{\"power_off\":false}"
                    );
                }
            }
        } else if (!stopPending) {
            stationarySinceMs = 0;
            controlledStopAlertReported = false;
        }

        // 4. Save state updates back to shared data structures
        xSemaphoreTake(stateMutex, portMAX_DELAY);
        
        // If a command arrived during this 50 ms tick, consume that newer shared
        // value. Comparing with the original snapshot preserves local transitions
        // such as ENDING -> LOCKED instead of restoring the older shared state.
        if (
            sharedTelemetry.session_state != "SAFE_FAULT"
            && !safetyInterlockActive
            && !stopPending
        ) {
            if (sharedTelemetry.power_state != observedPower) {
                power = sharedTelemetry.power_state;
            }
            if (sharedTelemetry.locked_state != observedLocked) {
                locked = sharedTelemetry.locked_state;
            }
            if (sharedTelemetry.session_state != observedState) {
                state = sharedTelemetry.session_state;
            }
            if (sharedTelemetry.time_left_s != observedTimeLeft) {
                timeLeft = sharedTelemetry.time_left_s;
            }
        }

        sharedTelemetry.session_state = state;
        sharedTelemetry.power_state = power;
        sharedTelemetry.locked_state = locked;
        sharedTelemetry.time_left_s = timeLeft;
        sharedTelemetry.tamper_alarm = tamperAlarmLatched;
        sharedTelemetry.tamper_warn_count = tamperWarnCount;
        xSemaphoreGive(stateMutex);

        // A mute covers only the hazards that were sounding when it was asked
        // for. Anything new re-arms the siren, and once everything clears the
        // mute is dropped so the next incident is audible from the start.
        {
            const uint8_t causes = activeAlarmCauses();
            if (causes == 0) {
                alarmSilenced = false;
                silencedCauses = 0;
            } else if (alarmSilenced && (causes & ~silencedCauses)) {
                alarmSilenced = false;
                silencedCauses = 0;
                Serial.println("[Safety] New hazard while muted — siren re-armed.");
            }
        }

        // 5. Update physical actuators based on final resolved states
        if (safetyInterlockActive) {
            const bool immediateEmergency = fallLatched || manualSOSLatched;
            const bool audibleEmergency =
                overtempLatched || fallLatched || manualSOSLatched;
            setMotionRelay(!immediateEmergency && inMotion);
            if (audibleEmergency) {
                // Muting silences the sound only — the relay above is
                // untouched, so a silenced chair is still cut out.
                buzzerWrite(!alarmSilenced);
                updateRGBLED(255, 0, 0);
            } else {
                // A missing/stale sensor remains a fail-safe motion interlock,
                // but must not create an endless siren or drain the battery.
                buzzerWrite(false);
                const bool faultIndicatorOn = ((loopTicks / 10) % 2) == 0;
                updateRGBLED(faultIndicatorOn ? 255 : 0, 0, 0);
            }
        } else {
            // Latched tamper alarm: continuous siren + fast red/blue LED flash.
            if (tamperAlarmLatched) {
                buzzerWrite(!alarmSilenced);
                updateRGBLED((loopTicks / 3) % 2 == 0 ? 255 : 0, 0, (loopTicks / 3) % 2 == 0 ? 0 : 255);
            } else {
                // Warning beep ticks
                if (buzzerBeepTicks > 0) {
                    buzzerWrite(true);
                } else {
                    buzzerWrite(false);
                }
                
                // LED state
                if (power) {
                    if (locked) {
                        updateRGBLED(0, 0, 255); // Solid Blue when Locked
                    } else if (state == "EXPIRING") {
                        updateRGBLED((loopTicks / 5) % 2 == 0 ? 255 : 0, (loopTicks / 5) % 2 == 0 ? 120 : 0, 0);
                    } else if (tilt <= TILT_WARN_DEG) {
                        updateRGBLED(0, 255, 0); // Solid Green when Active/Unlocked
                    }
                } else {
                    updateRGBLED(0, 0, 0); // Off
                }
            }

            if (isControlledStopPending() && inMotion) {
                setMotionRelay(true);
            } else if (power) {
                setMotionRelay(!locked);
            } else {
                setMotionRelay(false);
            }
        }

        vTaskDelayUntil(&lastWakeTime, pdMS_TO_TICKS(50)); // 20 Hz
    }
}

bool isSafetyFaultActive() {
    return (overtempLatched || fallLatched || manualSOSLatched || sensorFaultLatched);
}

bool isOTASafetyFaultActive() {
    return (overtempLatched || fallLatched || manualSOSLatched || sensorFaultLatched);
}
