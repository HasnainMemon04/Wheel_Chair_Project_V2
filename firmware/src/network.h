#pragma once
#include <Arduino.h>

// Initialize network parameters
void initNetwork();

// FreeRTOS tasks
void networkTask(void *pvParameters);
void uploadTelemetryTask(void *pvParameters);

// HMAC SHA-256 helper
String calculateHMAC(const String &payload, const String &key);

// Send discrete safety event payload
void reportSafetyEvent(const String &eventType, const String &detailJson);
