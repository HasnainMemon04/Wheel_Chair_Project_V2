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

// Operator maintenance override: time-limited suppression of the MISSING
// sensor interlock so a failed probe cannot strand a chair. Refuses (returns
// false, sets refusalReason) when the device can measure a real hazard.
bool requestMaintenanceOverride(uint32_t minutes, String &refusalReason);
void cancelMaintenanceOverride();
uint32_t maintenanceOverrideRemainingS();
