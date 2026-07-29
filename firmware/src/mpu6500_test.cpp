#include <Arduino.h>
#include <Wire.h>

namespace {
constexpr uint8_t kMpuAddress = 0x68;
constexpr uint8_t kSdaPin = 9;
constexpr uint8_t kSclPin = 8;

bool writeRegister(uint8_t reg, uint8_t value) {
    Wire.beginTransmission(kMpuAddress);
    Wire.write(reg);
    Wire.write(value);
    return Wire.endTransmission(true) == 0;
}

bool readRegisters(uint8_t reg, uint8_t *buffer, size_t length) {
    Wire.beginTransmission(kMpuAddress);
    Wire.write(reg);
    if (Wire.endTransmission(false) != 0) return false;

    const uint8_t requested = static_cast<uint8_t>(length);
    if (
        Wire.requestFrom(kMpuAddress, requested)
        != requested
    ) {
        return false;
    }

    for (size_t index = 0; index < length; index++) {
        buffer[index] = Wire.read();
    }
    return true;
}

int16_t readInt16(const uint8_t *buffer) {
    return static_cast<int16_t>(
        static_cast<uint16_t>(buffer[0]) << 8 | buffer[1]
    );
}
}

void setup() {
    Serial.begin(115200);
    delay(1000);
    Serial.println("--- MPU6500 production-pin bench test ---");
    Wire.begin(kSdaPin, kSclPin, 400000);

    uint8_t whoAmI = 0;
    if (!readRegisters(0x75, &whoAmI, 1)) {
        Serial.println("FAIL: no I2C response on SDA=GPIO9, SCL=GPIO8.");
        return;
    }
    Serial.printf("WHO_AM_I=0x%02X\n", whoAmI);
    if (whoAmI != 0x70 && whoAmI != 0x71 && whoAmI != 0x73) {
        Serial.println("FAIL: response is not a supported MPU6500-family identity.");
        return;
    }

    const bool configured =
        writeRegister(0x6B, 0x01)
        && writeRegister(0x1A, 0x03)
        && writeRegister(0x1B, 0x08)
        && writeRegister(0x1C, 0x08);
    Serial.println(configured ? "PASS: MPU6500 configured." : "FAIL: register configuration.");
}

void loop() {
    uint8_t sample[14] = {0};
    if (!readRegisters(0x3B, sample, sizeof(sample))) {
        Serial.println("FAIL: sample read.");
        delay(500);
        return;
    }

    constexpr float accelScale = 8192.0f;
    constexpr float gyroScale = 65.5f;
    Serial.printf(
        "A[g] %.3f %.3f %.3f | G[dps] %.2f %.2f %.2f\n",
        readInt16(&sample[0]) / accelScale,
        readInt16(&sample[2]) / accelScale,
        readInt16(&sample[4]) / accelScale,
        readInt16(&sample[8]) / gyroScale,
        readInt16(&sample[10]) / gyroScale,
        readInt16(&sample[12]) / gyroScale
    );
    delay(200);
}
