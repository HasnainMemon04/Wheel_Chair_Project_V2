#ifndef OTA_H
#define OTA_H

#include <Arduino.h>

// Initialize OTA and perform post-boot rollback check
void initOTA();

// Check if an OTA process is actively running
bool isOTABusy();

// Get the current download progress percentage (0 - 100)
int getOTAPercent();

// Handle an incoming OTA command. Returns false when the device rejects it
// before scheduling any OTA work.
bool handleOTACommand(
    const String &url,
    const String &version,
    size_t size,
    const String &sha256,
    bool maintenanceOverride = false
);

// Called when telemetry upload is successful to cancel rollback
void markFirmwareValid();

// Retrieve task stack high-water marks for active OTA components
void getOTATaskHighWaterMarks(unsigned int &downloadWatermark, unsigned int &schedulerWatermark, unsigned int &watchdogWatermark);

#endif // OTA_H
