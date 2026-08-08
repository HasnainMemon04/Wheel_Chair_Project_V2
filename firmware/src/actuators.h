#pragma once
#include <Arduino.h>

void initActuators();
void setMotionRelay(bool allowMotion);
void buzzerWrite(bool on);
void buzzerChirp(int count, int delayMs);
void buzzerAlarm(bool active);
void updateRGBLED(uint8_t r, uint8_t g, uint8_t b);
void applyActuatorStates();
void triggerManualSOS();
void clearManualSOS();
bool isManualSOSActive();

/**
 * Mute the siren without releasing any latch or the motion interlock.
 * Returns false (with a reason) when nothing is currently sounding.
 */
bool silenceAlarm(String &resultMessage);
bool isAlarmSilenced();
void clearTamper();
void requestControlledStop(bool powerOffAfterStop);
void cancelControlledStop();
bool isControlledStopPending();
void safetySupervisorTask(void *pvParameters);
bool isSafetyFaultActive();
bool isOTASafetyFaultActive();

/** Faults that block an OTA even with an operator override (fall / SOS / over-temp). */
bool isOTABlockingEmergency();

// Operator maintenance override: time-limited suppression of the MISSING
// sensor interlock so a failed probe cannot strand a chair. Refuses (returns
// false, sets refusalReason) when the device can measure a real hazard.
bool requestMaintenanceOverride(uint32_t minutes, String &refusalReason);
void cancelMaintenanceOverride();
uint32_t maintenanceOverrideRemainingS();

// ---- Emergency wheel unlock (second relay; fitted on WCHAIR-004 only) ------
//
// Cuts power to the electromagnetic wheel brake so the wheels free-wheel and
// the chair can be pushed by hand. This is NOT the motion lock: that decides
// whether the chair may drive itself, this decides whether it can be moved at
// all. They are independent on purpose — a chair immobilised by a safety
// interlock is exactly the chair somebody may need to push out of a doorway.
//
// hasEmergencyWheelUnlock() reports whether this build has the hardware, so
// the console can offer the control on the chair that has the relay and stay
// silent about it on the chairs that do not.
bool hasEmergencyWheelUnlock();

/**
 * Release the wheel brake for a bounded number of seconds.
 *
 * Deliberately NOT gated on safety interlocks: a fall, an SOS or a dead sensor
 * are the situations this exists for. The release is time-boxed, re-engages on
 * its own, and never survives a reboot.
 *
 * Returns false with a reason when the build has no relay fitted.
 */
bool requestEmergencyWheelUnlock(uint32_t seconds, String &resultMessage);

/** Re-engage the wheel brake immediately, cancelling any remaining hold. */
void engageEmergencyWheelLock();

/** Seconds left on an active release, 0 when the brake is engaged. */
uint32_t emergencyWheelUnlockRemainingS();

// ---- Emergency power cut (third relay; fitted on WCHAIR-004 only) ----------
//
// Cuts the wheelchair's MAIN power — independent of both the motion lock (may
// the chair drive?) and the wheel brake (can the chair be pushed?).
//
// Deliberately latching, not time-boxed. A power cut is the safe state, so
// nothing should silently restore it: it survives reboot in NVS and only an
// explicit operator command turns power back on. That is the opposite choice
// from the wheel unlock, and for the opposite reason.
bool hasPowerRelay();

/** True while main power is being held cut by an operator. */
bool isPowerCut();

/**
 * Cut or restore main power. Latches, and is persisted so a reboot cannot
 * quietly undo a deliberate cut.
 *
 * Returns false with a reason when the build has no relay fitted.
 */
bool setPowerCut(bool cut, String &resultMessage);

/** Re-assert the persisted power state at boot. Called once from setup. */
void restorePersistedPowerCut();
