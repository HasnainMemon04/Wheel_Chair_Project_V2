#include <Arduino.h>
#include <OneWire.h>
#include <DallasTemperature.h>

// Exact OneWire pin
#define ONEWIRE_PIN 10

OneWire oneWire(ONEWIRE_PIN);
DallasTemperature sensors(&oneWire);

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("--- DS18B20 OneWire Temp Sensors Standalone Test ---");

  sensors.begin();
  int deviceCount = sensors.getDeviceCount();
  Serial.printf("Discovered %d DS18B20 sensors on the bus.\n", deviceCount);

  for (int i = 0; i < deviceCount; i++) {
    DeviceAddress address;
    if (sensors.getAddress(address, i)) {
      Serial.printf("  Sensor %d Address: ", i);
      for (uint8_t j = 0; j < 8; j++) {
        Serial.printf("%02X", address[j]);
      }
      Serial.println();
    }
  }
}

void loop() {
  int deviceCount = sensors.getDeviceCount();
  if (deviceCount == 0) {
    Serial.println("Error: No DS18B20 sensors connected! Check wiring on GPIO10.");
    delay(3000);
    return;
  }

  Serial.println("\nRequesting temperatures...");
  sensors.requestTemperatures();

  for (int i = 0; i < deviceCount; i++) {
    float tempC = sensors.getTempCByIndex(i);
    if (tempC != DEVICE_DISCONNECTED_C) {
      Serial.printf("  Sensor %d (Index %d): %.2f °C\n", i, i, tempC);
    } else {
      Serial.printf("  Sensor %d (Index %d): ERROR Reading\n", i, i);
    }
  }

  delay(2000);
}
