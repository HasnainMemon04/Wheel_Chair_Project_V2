#include <Arduino.h>
#include <DHT.h>

// Exact DHT pin
#define DHT_PIN  5
#define DHT_TYPE DHT22

DHT dht(DHT_PIN, DHT_TYPE);

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("--- DHT22 Ambient Sensor Standalone Test ---");

  dht.begin();
  Serial.println("DHT22 initialized. Testing communication...");
}

void loop() {
  float h = dht.readHumidity();
  float t = dht.readTemperature();

  if (isnan(h) || isnan(t)) {
    Serial.println("Error: Failed to read from DHT22 sensor! Check wiring on pin 5.");
  } else {
    Serial.printf("Ambient Temp: %.1f °C | Ambient Humidity: %.1f %%\n", t, h);
  }

  delay(2000);
}
