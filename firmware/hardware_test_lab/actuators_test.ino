#include <Arduino.h>

// Exact actuator pins
#define RELAY_POWER_PIN  25   // CH1 main power relay
#define RELAY_MOTION_PIN 26   // CH2 motion lock relay
#define BUZZER_PIN       13   // Piezo Buzzer Module (exact pin 13)
#define STATUS_LED_PIN   2    // Onboard status LED
#define RELAY_ACTIVE_LOW 1    // Relay triggers on LOW if active-low
#define BUZZER_ACTIVE_LOW 0   // 0 = active-high, 1 = active-low

void buzzerWrite(bool on) {
  bool pinValue = on;
  if (BUZZER_ACTIVE_LOW) pinValue = !on;
  digitalWrite(BUZZER_PIN, pinValue ? HIGH : LOW);
}

void setPowerRelay(bool on) {
  bool pinValue = on;
  if (RELAY_ACTIVE_LOW) pinValue = !on;
  digitalWrite(RELAY_POWER_PIN, pinValue ? HIGH : LOW);
}

void setMotionRelay(bool allowMotion) {
  bool pinValue = allowMotion;
  if (RELAY_ACTIVE_LOW) pinValue = !allowMotion;
  digitalWrite(RELAY_MOTION_PIN, pinValue ? HIGH : LOW);
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("--- Actuators Relay + Buzzer Standalone Test ---");

  pinMode(RELAY_POWER_PIN, OUTPUT);
  pinMode(RELAY_MOTION_PIN, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(STATUS_LED_PIN, OUTPUT);

  // Default fail-safe state
  setPowerRelay(false);
  setMotionRelay(false);
  buzzerWrite(false);
  digitalWrite(STATUS_LED_PIN, LOW);
  
  Serial.println("Outputs configured. Commencing 3-second cycle tests...");
}

void loop() {
  // Test Buzzer
  Serial.println("\n[ buzzer beep ]");
  digitalWrite(STATUS_LED_PIN, HIGH);
  buzzerWrite(true);
  delay(100);
  buzzerWrite(false);
  digitalWrite(STATUS_LED_PIN, LOW);
  delay(100);
  buzzerWrite(true);
  delay(100);
  buzzerWrite(false);
  
  // Test Relay CH1
  Serial.println("Toggling Power Relay CH1 (Pin 25): ON...");
  setPowerRelay(true);
  delay(3000);
  Serial.println("Toggling Power Relay CH1 (Pin 25): OFF...");
  setPowerRelay(false);
  delay(1500);

  // Test Relay CH2
  Serial.println("Toggling Motion Relay CH2 (Pin 26): ALLOW MOTION...");
  setMotionRelay(true);
  delay(3000);
  Serial.println("Toggling Motion Relay CH2 (Pin 26): LOCK MOTION...");
  setMotionRelay(false);
  delay(1500);
}
