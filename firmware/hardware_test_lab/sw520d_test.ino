#include <Arduino.h>

// Exact tilt pin
#define TILT_SWITCH_PIN 14 // SW-520D digital tilt switch

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("--- SW-520D Tilt Switch Standalone Test ---");

  pinMode(TILT_SWITCH_PIN, INPUT_PULLUP);
  Serial.println("Pin 14 configured as INPUT_PULLUP. Tilt the sensor past 15 degrees to trigger...");
}

void loop() {
  // SW-520D is closed (conductive, LOW) when upright, and opens (HIGH) when tilted
  int state = digitalRead(TILT_SWITCH_PIN);
  
  if (state == LOW) {
    Serial.println("Orientation: UPRIGHT (LOW / Switch Closed)");
  } else {
    Serial.println("Orientation: TILTED / FALLEN! (HIGH / Switch Open)");
  }

  delay(250);
}
