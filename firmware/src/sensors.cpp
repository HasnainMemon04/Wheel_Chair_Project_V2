#include "sensors.h"
#include "config.h"
#include <Wire.h>
#include <TinyGPS++.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <Preferences.h>
#include <esp_task_wdt.h>
#include <math.h>
#include <stdlib.h>

// Global structures
TelemetryData sharedTelemetry;
SemaphoreHandle_t stateMutex = NULL;

// Drivers
HardwareSerial GPSSerial(1);
TinyGPSPlus gps;

bool mpuOK = false;

// MPU6500 6-Axis state
static float g_ax = 0, g_ay = 0, g_az = 0;
static float g_gx = 0, g_gy = 0, g_gz = 0;
static float g_pitch_cf = 0, g_roll_cf = 0, g_yaw_cf = 0;

static float gyroBiasX = 0, gyroBiasY = 0, gyroBiasZ = 0;
static float pitchOffset = 0, rollOffset = 0;
// True once a level reference has been established — either loaded from NVS or
// captured by an operator. Reported in telemetry so the console can say
// whether the angles it is showing are referenced to anything.
static bool imuLevelCalibrated = false;
static unsigned long lastFusionMicros = 0;
static uint32_t imuReadFailures = 0;
static uint32_t lastImuRecoveryAttemptMs = 0;
static Preferences sensorPreferences;

// Direct I2C helper functions for MPU6500
static bool writeMpuRegister(uint8_t reg, uint8_t value) {
    Wire.beginTransmission(MPU6500_ADDR);
    Wire.write(reg);
    Wire.write(value);
    return Wire.endTransmission() == 0;
}

static bool readMpuRegister(uint8_t reg, uint8_t &value) {
    Wire.beginTransmission(MPU6500_ADDR);
    Wire.write(reg);
    if (Wire.endTransmission(false) != 0) return false;
    if (
        Wire.requestFrom(
            static_cast<uint8_t>(MPU6500_ADDR),
            static_cast<uint8_t>(1)
        ) != 1
    ) {
        return false;
    }
    value = Wire.read();
    return true;
}

static bool init6Axis() {
    uint8_t whoAmI = 0;
    if (!readMpuRegister(0x75, whoAmI)) return false;
    if (whoAmI != 0x70 && whoAmI != 0x71 && whoAmI != 0x73) {
        Serial.printf("[Sensors] Unsupported MPU WHO_AM_I: 0x%02X\n", whoAmI);
        return false;
    }

    // Wake up MPU and select the PLL clock.
    if (!writeMpuRegister(0x6B, 0x01)) return false;
    delay(10);

    const uint8_t accelConfig = MPU_ACCEL_RANGE_G == 8 ? 0x10
        : MPU_ACCEL_RANGE_G == 4 ? 0x08
        : MPU_ACCEL_RANGE_G == 16 ? 0x18
        : 0x00;
    const uint8_t gyroConfig = MPU_GYRO_RANGE_DPS == 500 ? 0x08
        : MPU_GYRO_RANGE_DPS == 1000 ? 0x10
        : MPU_GYRO_RANGE_DPS == 2000 ? 0x18
        : 0x00;

    // 41 Hz DLPF with enough range to avoid clipping chair impacts.
    return writeMpuRegister(0x1A, 0x03)
        && writeMpuRegister(0x1D, 0x03)
        && writeMpuRegister(0x1C, accelConfig)
        && writeMpuRegister(0x1B, gyroConfig);
}

static bool read6Axis(float &ax, float &ay, float &az, float &gx, float &gy, float &gz) {
    Wire.beginTransmission(MPU6500_ADDR);
    Wire.write(0x3B); // ACCEL_XOUT_H
    if (Wire.endTransmission(false) != 0) return false;

    Wire.requestFrom(MPU6500_ADDR, 14);
    if (Wire.available() < 14) return false;

    int16_t raw_ax = (Wire.read() << 8) | Wire.read();
    int16_t raw_ay = (Wire.read() << 8) | Wire.read();
    int16_t raw_az = (Wire.read() << 8) | Wire.read();
    Wire.read(); Wire.read(); // skip temp
    int16_t raw_gx = (Wire.read() << 8) | Wire.read();
    int16_t raw_gy = (Wire.read() << 8) | Wire.read();
    int16_t raw_gz = (Wire.read() << 8) | Wire.read();

    const float accelScale = MPU_ACCEL_RANGE_G == 4 ? 8192.0f
        : MPU_ACCEL_RANGE_G == 8 ? 4096.0f
        : MPU_ACCEL_RANGE_G == 16 ? 2048.0f
        : 16384.0f;
    const float gyroScale = MPU_GYRO_RANGE_DPS == 500 ? 65.5f
        : MPU_GYRO_RANGE_DPS == 1000 ? 32.8f
        : MPU_GYRO_RANGE_DPS == 2000 ? 16.4f
        : 131.0f;
    ax = raw_ax / accelScale;
    ay = raw_ay / accelScale;
    az = raw_az / accelScale;
    gx = raw_gx / gyroScale;
    gy = raw_gy / gyroScale;
    gz = raw_gz / gyroScale;

    return true;
}

OneWire oneWire(ONEWIRE_PIN);
DallasTemperature tempSensors(&oneWire);
bool dsOK = false;
DeviceAddress battAddress;
bool battSensorOK = false;

// Rolling variance tracking for micro-movement motion/vibration estimation
static float smoothAccDiff = 0.0f;
static float lastAccMag = 9.80665f;
static float calibratedGyroRateDps = 0.0f;

static bool loadGeofenceConfig(double &lat, double &lng, float &radius, bool &enabled) {
    if (!sensorPreferences.begin("sensor_cfg", false)) return false;
    const uint32_t marker = sensorPreferences.isKey("gf_marker")
        ? sensorPreferences.getUInt("gf_marker", 0)
        : 0;
    if (marker != 0x47463031UL) {
        sensorPreferences.end();
        return false;
    }

    lat = sensorPreferences.getDouble("gf_lat", NAN);
    lng = sensorPreferences.getDouble("gf_lng", NAN);
    radius = sensorPreferences.getFloat("gf_radius", GEOFENCE_RADIUS_M);
    enabled = sensorPreferences.getBool("gf_enabled", false);
    sensorPreferences.end();

    return isfinite(lat)
        && isfinite(lng)
        && lat >= -90.0
        && lat <= 90.0
        && lng >= -180.0
        && lng <= 180.0
        && radius >= 50.0f
        && radius <= 2000.0f;
}

bool saveGeofenceConfig(double lat, double lng, float radius, bool enabled) {
    if (!isfinite(lat) || !isfinite(lng) || lat < -90.0 || lat > 90.0
        || lng < -180.0 || lng > 180.0 || radius < 50.0f || radius > 2000.0f) {
        return false;
    }
    if (!sensorPreferences.begin("sensor_cfg", false)) return false;
    bool ok = sensorPreferences.putDouble("gf_lat", lat) == sizeof(double);
    ok = sensorPreferences.putDouble("gf_lng", lng) == sizeof(double) && ok;
    ok = sensorPreferences.putFloat("gf_radius", radius) == sizeof(float) && ok;
    ok = sensorPreferences.putBool("gf_enabled", enabled) == sizeof(bool) && ok;
    ok = sensorPreferences.putUInt("gf_marker", 0x47463031UL) == sizeof(uint32_t) && ok;
    sensorPreferences.end();
    return ok;
}

// --------------------------------------------------------------------------
// Last known good position (NVS).
//
// Without this the fallback anchor resets to a hard-coded default on every
// boot, so a chair powered on indoors — where it may never see a satellite —
// would report a location it has never been to. Persisting the last real fix
// lets it resume from where it actually was.
//
// Writes are throttled (see LAST_FIX_SAVE_*) because NVS is flash.
// --------------------------------------------------------------------------
static bool loadLastKnownFix(double &lat, double &lng) {
    if (!sensorPreferences.begin("sensor_cfg", false)) return false;
    const uint32_t marker = sensorPreferences.isKey("lf_marker")
        ? sensorPreferences.getUInt("lf_marker", 0)
        : 0;
    if (marker != 0x4C463031UL) {
        sensorPreferences.end();
        return false;
    }
    lat = sensorPreferences.getDouble("lf_lat", NAN);
    lng = sensorPreferences.getDouble("lf_lng", NAN);
    sensorPreferences.end();

    return isfinite(lat) && isfinite(lng)
        && lat >= -90.0 && lat <= 90.0
        && lng >= -180.0 && lng <= 180.0
        && !(lat == 0.0 && lng == 0.0);
}

static bool saveLastKnownFix(double lat, double lng) {
    if (!isfinite(lat) || !isfinite(lng)
        || lat < -90.0 || lat > 90.0
        || lng < -180.0 || lng > 180.0
        || (lat == 0.0 && lng == 0.0)) {
        return false;
    }
    if (!sensorPreferences.begin("sensor_cfg", false)) return false;
    bool ok = sensorPreferences.putDouble("lf_lat", lat) == sizeof(double);
    ok = sensorPreferences.putDouble("lf_lng", lng) == sizeof(double) && ok;
    ok = sensorPreferences.putUInt("lf_marker", 0x4C463031UL) == sizeof(uint32_t) && ok;
    sensorPreferences.end();
    return ok;
}

// --------------------------------------------------------------------------
// Level reference (pitch/roll zero), persisted in NVS.
//
// The MPU6500 has a factory accelerometer bias of a few degrees, so raw
// pitch/roll are never 0/0 on a flat surface. Subtracting a stored reference
// is what makes "level" mean level.
//
// Persisting it matters as much as measuring it: this used to be re-derived on
// every boot from whatever pose the chair happened to be in. Boot it on a
// slope and the slope became zero; boot it while being carried and the
// stationary check failed, the offsets fell back to 0, and the raw factory
// bias showed through as a permanent few-degree lean. Stored once, it now
// survives reboots and OTA.
// --------------------------------------------------------------------------
static bool loadImuLevelOffsets(float &pitchOff, float &rollOff,
                                float &gbX, float &gbY, float &gbZ) {
    if (!sensorPreferences.begin("sensor_cfg", false)) return false;
    const uint32_t marker = sensorPreferences.isKey("imu_marker")
        ? sensorPreferences.getUInt("imu_marker", 0)
        : 0;
    if (marker != 0x494D5531UL) {
        sensorPreferences.end();
        return false;
    }
    pitchOff = sensorPreferences.getFloat("imu_pitch", NAN);
    rollOff = sensorPreferences.getFloat("imu_roll", NAN);
    gbX = sensorPreferences.getFloat("imu_gbx", NAN);
    gbY = sensorPreferences.getFloat("imu_gby", NAN);
    gbZ = sensorPreferences.getFloat("imu_gbz", NAN);
    sensorPreferences.end();
    // A stored reference beyond +/-45 deg is not a mounting tolerance, it is a
    // bad capture; ignore it rather than bake a wrong zero in permanently.
    // Likewise a bias past +/-30 deg/s is a broken part, not an offset.
    return isfinite(pitchOff) && isfinite(rollOff)
        && isfinite(gbX) && isfinite(gbY) && isfinite(gbZ)
        && fabsf(pitchOff) <= 45.0f && fabsf(rollOff) <= 45.0f
        && fabsf(gbX) <= 30.0f && fabsf(gbY) <= 30.0f && fabsf(gbZ) <= 30.0f;
}

static bool saveImuLevelOffsets(float pitchOff, float rollOff,
                                float gbX, float gbY, float gbZ) {
    if (!isfinite(pitchOff) || !isfinite(rollOff)) return false;
    if (!isfinite(gbX) || !isfinite(gbY) || !isfinite(gbZ)) return false;
    if (!sensorPreferences.begin("sensor_cfg", false)) return false;
    bool ok = sensorPreferences.putFloat("imu_pitch", pitchOff) == sizeof(float);
    ok = sensorPreferences.putFloat("imu_roll", rollOff) == sizeof(float) && ok;
    ok = sensorPreferences.putFloat("imu_gbx", gbX) == sizeof(float) && ok;
    ok = sensorPreferences.putFloat("imu_gby", gbY) == sizeof(float) && ok;
    ok = sensorPreferences.putFloat("imu_gbz", gbZ) == sizeof(float) && ok;
    ok = sensorPreferences.putUInt("imu_marker", 0x494D5531UL) == sizeof(uint32_t) && ok;
    sensorPreferences.end();
    return ok;
}

/**
 * Capture the chair's CURRENT pose as level, and persist it.
 *
 * Refuses while the chair is moving: whatever is captured becomes the
 * permanent definition of flat, so a sample taken mid-bump would bake that
 * bump in. The refusal reason is returned so the operator sees why rather than
 * a silent failure.
 */
bool calibrateImuLevel(String &resultMessage) {
    if (!mpuOK) {
        resultMessage = "IMU is not responding — nothing to calibrate.";
        return false;
    }

    // Gyro bias is measured HERE rather than trusted from boot.
    //
    // Judging stillness by |gyro| cannot work while the bias is unknown: this
    // part reads ~6 deg/s at rest, so an absolute threshold rejects a
    // motionless chair forever and calibration can never succeed. Stillness is
    // therefore judged by how much the readings VARY, which is near zero at
    // rest whatever the bias happens to be — and the mean of those same
    // samples IS the bias.
    //
    // Getting this right also fixes the wobble: the complementary filter
    // integrates gyro rate, so an uncorrected 6 deg/s bias pushes the angle
    // constantly while the accelerometer term drags it back.
    // Stillness is judged by standard deviation, not peak-to-peak. At 8 ms
    // intervals a single noise spike blows a min/max range and would veto an
    // otherwise motionless capture forever; sigma weighs the whole window, so
    // real movement (sustained rotation) separates cleanly from sensor noise.
    float sumGX = 0, sumGY = 0, sumGZ = 0;
    float sqGX = 0, sqGY = 0, sqGZ = 0;
    float sumPitch = 0, sumRoll = 0, sumMag = 0, sqMag = 0;
    int count = 0;

    for (int i = 0; i < 150; i++) {
        float ax, ay, az, gx, gy, gz;
        if (read6Axis(ax, ay, az, gx, gy, gz)) {
            const float accelMag = sqrtf(ax * ax + ay * ay + az * az);
            sumGX += gx; sumGY += gy; sumGZ += gz;
            sqGX += gx * gx; sqGY += gy * gy; sqGZ += gz * gz;
            sumMag += accelMag; sqMag += accelMag * accelMag;
            sumPitch += atan2(ay, sqrt(ax * ax + az * az)) * 180.0 / PI;
            sumRoll  += atan2(-ax, az) * 180.0 / PI;
            count++;
        }
        delay(8);
    }

    if (count < 120) {
        resultMessage = "Could not read the IMU reliably — check the I2C wiring.";
        return false;
    }

    auto sigma = [count](float sum, float sumSq) -> float {
        const float mean = sum / count;
        const float var = (sumSq / count) - (mean * mean);
        return var > 0.0f ? sqrtf(var) : 0.0f;
    };
    const float gyroSigma = max(sigma(sumGX, sqGX), max(sigma(sumGY, sqGY), sigma(sumGZ, sqGZ)));
    const float magSigma = sigma(sumMag, sqMag);

    // The gyro is the real discriminator: a chair cannot be moved by hand
    // without rotating, and it reads a few hundredths of a deg/s at rest on
    // every board tested. The accelerometer is only a sanity check, and its
    // noise floor varies a lot between units — one board sat at 0.074 g while
    // its gyro read 0.1 deg/s, which is a noisy part, not movement. Tuning the
    // accel limit to the quietest board made calibration impossible on the
    // noisiest one, so it is set well above any observed noise floor and well
    // below anything handling produces (which is several tenths of a g).
    if (gyroSigma > 2.5f || magSigma > 0.18f) {
        resultMessage = "Chair was moving (gyro " + String(gyroSigma, 1)
            + " deg/s, accel " + String(magSigma, 3)
            + " g) — hold it still on a level surface and try again.";
        return false;
    }

    const float meanMag = sumMag / count;
    if (meanMag < 0.90f || meanMag > 1.10f) {
        resultMessage = "Accelerometer is not reading 1g at rest — check the IMU mounting.";
        return false;
    }

    const float newPitch = sumPitch / count;
    const float newRoll = sumRoll / count;
    if (fabsf(newPitch) > 45.0f || fabsf(newRoll) > 45.0f) {
        resultMessage = "Chair is not close to level — calibrate it standing flat on the ground.";
        return false;
    }

    // Still and level: the means are the references.
    gyroBiasX = sumGX / count;
    gyroBiasY = sumGY / count;
    gyroBiasZ = sumGZ / count;
    pitchOffset = newPitch;
    rollOffset = newRoll;
    imuLevelCalibrated = true;
    Serial.printf(
        "[Sensors] Gyro bias from calibration: %.2f, %.2f, %.2f deg/s "
        "(gyro sigma %.2f deg/s, accel sigma %.3f g).\n",
        gyroBiasX, gyroBiasY, gyroBiasZ, gyroSigma, magSigma
    );

    // Snap the fused angles to zero instead of letting the filter walk there
    // over the next few seconds, which would look like a fault to an operator
    // watching the numbers.
    g_pitch_cf = 0.0f;
    g_roll_cf = 0.0f;

    const bool stored = saveImuLevelOffsets(pitchOffset, rollOffset, gyroBiasX, gyroBiasY, gyroBiasZ);
    Serial.printf(
        "[Sensors] Level calibrated: pitch %.2f deg, roll %.2f deg (%d samples, stored=%s).\n",
        pitchOffset, rollOffset, count, stored ? "yes" : "NO"
    );

    resultMessage = stored
        ? "Level set. Pitch and roll now read zero here."
        : "Level set for this session, but it could not be saved and will be lost on reboot.";
    return true;
}

bool imuIsLevelCalibrated() {
    return imuLevelCalibrated;
}

static int nmeaHexNibble(char value) {
    if (value >= '0' && value <= '9') return value - '0';
    if (value >= 'A' && value <= 'F') return value - 'A' + 10;
    if (value >= 'a' && value <= 'f') return value - 'a' + 10;
    return -1;
}

static bool hasValidNmeaChecksum(const char *sentence) {
    if (sentence == nullptr || sentence[0] != '$') return false;

    const char *checksumMarker = strchr(sentence, '*');
    if (checksumMarker == nullptr || checksumMarker == sentence + 1) return false;
    if (checksumMarker[1] == '\0' || checksumMarker[2] == '\0') return false;

    const int highNibble = nmeaHexNibble(checksumMarker[1]);
    const int lowNibble = nmeaHexNibble(checksumMarker[2]);
    if (highNibble < 0 || lowNibble < 0) return false;

    uint8_t calculated = 0;
    for (const char *cursor = sentence + 1; cursor < checksumMarker; cursor++) {
        calculated ^= static_cast<uint8_t>(*cursor);
    }

    const uint8_t expected = static_cast<uint8_t>((highNibble << 4) | lowNibble);
    return calculated == expected;
}

struct UbxFrameParser {
    uint8_t state = 0;
    uint8_t messageClass = 0;
    uint8_t messageId = 0;
    uint8_t lastMessageClass = 0;
    uint8_t lastMessageId = 0;
    uint8_t checksumA = 0;
    uint8_t checksumB = 0;
    uint16_t payloadLength = 0;
    uint16_t payloadRead = 0;

    void reset() {
        state = 0;
        messageClass = 0;
        messageId = 0;
        checksumA = 0;
        checksumB = 0;
        payloadLength = 0;
        payloadRead = 0;
    }

    void addChecksum(uint8_t value) {
        checksumA = static_cast<uint8_t>(checksumA + value);
        checksumB = static_cast<uint8_t>(checksumB + checksumA);
    }

    bool feed(uint8_t value) {
        switch (state) {
            case 0:
                if (value == 0xB5) state = 1;
                break;
            case 1:
                if (value == 0x62) {
                    state = 2;
                } else {
                    state = value == 0xB5 ? 1 : 0;
                }
                break;
            case 2:
                messageClass = value;
                addChecksum(value);
                state = 3;
                break;
            case 3:
                messageId = value;
                addChecksum(value);
                state = 4;
                break;
            case 4:
                payloadLength = value;
                addChecksum(value);
                state = 5;
                break;
            case 5:
                payloadLength |= static_cast<uint16_t>(value) << 8;
                addChecksum(value);
                if (payloadLength > 1024) {
                    reset();
                } else {
                    state = payloadLength == 0 ? 7 : 6;
                }
                break;
            case 6:
                addChecksum(value);
                payloadRead++;
                if (payloadRead >= payloadLength) state = 7;
                break;
            case 7:
                if (value == checksumA) {
                    state = 8;
                } else {
                    reset();
                }
                break;
            case 8: {
                const bool valid = value == checksumB;
                if (valid) {
                    lastMessageClass = messageClass;
                    lastMessageId = messageId;
                }
                reset();
                return valid;
            }
            default:
                reset();
                break;
        }
        return false;
    }
};

static void sendUbxCommand(
    uint8_t messageClass,
    uint8_t messageId,
    const uint8_t *payload,
    uint16_t payloadLength
) {
    const uint8_t header[] = {
        0xB5,
        0x62,
        messageClass,
        messageId,
        static_cast<uint8_t>(payloadLength & 0xFF),
        static_cast<uint8_t>((payloadLength >> 8) & 0xFF)
    };

    uint8_t checksumA = 0;
    uint8_t checksumB = 0;
    for (size_t i = 2; i < sizeof(header); i++) {
        checksumA = static_cast<uint8_t>(checksumA + header[i]);
        checksumB = static_cast<uint8_t>(checksumB + checksumA);
    }
    for (uint16_t i = 0; i < payloadLength; i++) {
        checksumA = static_cast<uint8_t>(checksumA + payload[i]);
        checksumB = static_cast<uint8_t>(checksumB + checksumA);
    }

    GPSSerial.write(header, sizeof(header));
    if (payload != nullptr && payloadLength > 0) {
        GPSSerial.write(payload, payloadLength);
    }
    const uint8_t checksum[] = { checksumA, checksumB };
    GPSSerial.write(checksum, sizeof(checksum));
    GPSSerial.flush();
}

static void pollUbxVersion() {
    sendUbxCommand(0x0A, 0x04, nullptr, 0);
}

static void enableUbxNmeaMessage(uint8_t nmeaMessageId) {
    // Rates: I2C, UART1, UART2, USB, SPI, reserved.
    const uint8_t payload[] = {
        0xF0, nmeaMessageId, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00
    };
    sendUbxCommand(0x06, 0x01, payload, sizeof(payload));
    delay(40);
}

static void recoverUbxGpsToNmea(int rxPin, int txPin) {
    Serial.println("[Sensors] Valid UBX receiver detected. Restoring persistent NMEA output.");

    enableUbxNmeaMessage(0x00); // GGA: fix, coordinates, satellites, HDOP
    enableUbxNmeaMessage(0x04); // RMC: position, speed, course, date/time

    const uint8_t rate5Hz[] = {
        0xC8, 0x00, // 200 ms measurement period
        0x01, 0x00, // one navigation cycle per measurement
        0x01, 0x00  // GPS time reference
    };
    sendUbxCommand(0x06, 0x08, rate5Hz, sizeof(rate5Hz));
    delay(60);

    const uint32_t targetBaud = 115200;
    uint8_t uart1Config[] = {
        0x01, 0x00, 0x00, 0x00, // UART1
        0xD0, 0x08, 0x00, 0x00, // 8 data bits, no parity, 1 stop bit
        0x00, 0x00, 0x00, 0x00, // baud rate, filled below
        0x07, 0x00,             // accept UBX, NMEA, and RTCM
        0x03, 0x00,             // emit UBX and NMEA
        0x00, 0x00,
        0x00, 0x00
    };
    uart1Config[8] = static_cast<uint8_t>(targetBaud & 0xFF);
    uart1Config[9] = static_cast<uint8_t>((targetBaud >> 8) & 0xFF);
    uart1Config[10] = static_cast<uint8_t>((targetBaud >> 16) & 0xFF);
    uart1Config[11] = static_cast<uint8_t>((targetBaud >> 24) & 0xFF);
    sendUbxCommand(0x06, 0x00, uart1Config, sizeof(uart1Config));
    delay(180);

    GPSSerial.begin(targetBaud, SERIAL_8N1, rxPin, txPin);
    delay(120);

    // Persist message rates and UART1 configuration to battery-backed RAM and flash.
    const uint8_t saveConfig[] = {
        0x00, 0x00, 0x00, 0x00, // clear nothing
        0xFF, 0xFF, 0x00, 0x00, // save all supported configuration groups
        0x00, 0x00, 0x00, 0x00, // load nothing
        0x03                    // battery-backed RAM and flash
    };
    sendUbxCommand(0x06, 0x09, saveConfig, sizeof(saveConfig));
    delay(200);
    pollUbxVersion();

    Serial.println("[Sensors] GPS recovery applied: GGA/RMC at 5 Hz, UART1 at 115200 baud.");
}


void configureM8NGPS() {
    Serial.println("[Sensors] Optimizing NEO-M8N GNSS Settings...");

    // UBX-CFG-NAV5: Set dynamic platform model to Pedestrian (Dynamic Model = 3)
    uint8_t cfg_nav5[] = {
        0xB5, 0x62, 0x06, 0x24, 0x24, 0x00, 0xFF, 0xFF, 0x03, 0x03,
        0x00, 0x00, 0x00, 0x00, 0x10, 0x27, 0x00, 0x00, 0x05, 0x00,
        0xFA, 0x00, 0xFA, 0x00, 0x64, 0x00, 0x2C, 0x01, 0x00, 0x3C,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x16, 0xDC
    };
    GPSSerial.write(cfg_nav5, sizeof(cfg_nav5));
    delay(50);

    // UBX-CFG-MSG: Disable GLL (Geographical Position)
    uint8_t disable_gll[] = { 0xB5, 0x62, 0x06, 0x01, 0x08, 0x00, 0xF0, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x1F };
    GPSSerial.write(disable_gll, sizeof(disable_gll));
    delay(50);

    // UBX-CFG-MSG: Disable GSA (DOP & Active Satellites)
    uint8_t disable_gsa[] = { 0xB5, 0x62, 0x06, 0x01, 0x08, 0x00, 0xF0, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x26 };
    GPSSerial.write(disable_gsa, sizeof(disable_gsa));
    delay(50);

    // UBX-CFG-MSG: Disable GSV (Satellites in View - very heavy)
    uint8_t disable_gsv[] = { 0xB5, 0x62, 0x06, 0x01, 0x08, 0x00, 0xF0, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x2D };
    GPSSerial.write(disable_gsv, sizeof(disable_gsv));
    delay(50);

    // UBX-CFG-MSG: Disable VTG (Course over ground & Ground speed)
    uint8_t disable_vtg[] = { 0xB5, 0x62, 0x06, 0x01, 0x08, 0x00, 0xF0, 0x05, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05, 0x3B };
    GPSSerial.write(disable_vtg, sizeof(disable_vtg));
    delay(50);

    // UBX-CFG-MSG: Disable ZDA (Time & Date)
    uint8_t disable_zda[] = { 0xB5, 0x62, 0x06, 0x01, 0x08, 0x00, 0xF0, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x08, 0x50 };
    GPSSerial.write(disable_zda, sizeof(disable_zda));
    delay(50);

    // UBX-CFG-RATE: Configure Measurement Update Rate to 5Hz (200ms)
    // This provides high-frequency, ultra-responsive speed and position data
    uint8_t cfg_rate_5hz[] = { 0xB5, 0x62, 0x06, 0x08, 0x06, 0x00, 0xC8, 0x00, 0x01, 0x00, 0x01, 0x00, 0xDE, 0x6A };
    GPSSerial.write(cfg_rate_5hz, sizeof(cfg_rate_5hz));
    delay(100);

    Serial.println("[Sensors] NEO-M8N GNSS configured to 5Hz update rate, NMEA optimized.");
}


void initSensors() {
    stateMutex = xSemaphoreCreateMutex();
    if (stateMutex == NULL) {
        Serial.println("[Fatal] Could not create telemetry state mutex.");
        delay(1000);
        ESP.restart();
    }

    double persistedGeofenceLat = NAN;
    double persistedGeofenceLng = NAN;
    float persistedGeofenceRadius = GEOFENCE_RADIUS_M;
    bool persistedGeofenceEnabled = false;
    const bool havePersistedGeofence = loadGeofenceConfig(
        persistedGeofenceLat,
        persistedGeofenceLng,
        persistedGeofenceRadius,
        persistedGeofenceEnabled
    );

    // Initialize default states
    xSemaphoreTake(stateMutex, portMAX_DELAY);
    sharedTelemetry.uptime_s = 0;
    sharedTelemetry.gps_fix = false;
    sharedTelemetry.gps_simulated = true;
    sharedTelemetry.gps_fallback_anchor_lat = 24.8601;
    sharedTelemetry.gps_fallback_anchor_lng = 67.0637;
    sharedTelemetry.gps_fallback_anchor_revision = 1;
    sharedTelemetry.gps_lat = 24.8601;
    sharedTelemetry.gps_lng = 67.0637;
    // Unknown until a real fix arrives — never a plausible-looking default.
    sharedTelemetry.gps_speed_kmh = NAN;
    sharedTelemetry.gps_physical_lat = NAN;
    sharedTelemetry.gps_physical_lng = NAN;
    sharedTelemetry.gps_physical_speed_kmh = 0.0f;
    sharedTelemetry.gps_physical_course_deg = NAN;
    sharedTelemetry.gps_physical_altitude_m = NAN;
    sharedTelemetry.gps_sats = 0;
    sharedTelemetry.gps_hdop = NAN;
    sharedTelemetry.gps_course_deg = NAN;
    sharedTelemetry.gps_altitude_m = NAN;
    sharedTelemetry.gps_last_data_ms = 0;
    sharedTelemetry.gps_last_fix_ms = 0;
    sharedTelemetry.gps_chars_processed = 0;
    sharedTelemetry.gps_sentences_valid = 0;
    sharedTelemetry.gps_checksum_failures = 0;
    sharedTelemetry.gps_nmea_gga[0] = '\0';
    sharedTelemetry.gps_nmea_rmc[0] = '\0';
    sharedTelemetry.pitch = NAN;
    sharedTelemetry.roll = NAN;
    sharedTelemetry.tilt = NAN;
    sharedTelemetry.yaw = NAN;
    sharedTelemetry.imu_accel_x_g = NAN;
    sharedTelemetry.imu_accel_y_g = NAN;
    sharedTelemetry.imu_accel_z_g = NAN;
    sharedTelemetry.imu_gyro_x_dps = NAN;
    sharedTelemetry.imu_gyro_y_dps = NAN;
    sharedTelemetry.imu_gyro_z_dps = NAN;
    sharedTelemetry.imu_last_sample_ms = 0;
    sharedTelemetry.imu_valid = false;
    sharedTelemetry.imu_read_failures = 0;
    sharedTelemetry.temp_battery = NAN;
    sharedTelemetry.temp_valid = false;
    sharedTelemetry.temp_last_sample_ms = 0;
    sharedTelemetry.batt_v = 3.7;
    sharedTelemetry.batt_pct = 50;
    sharedTelemetry.batt_valid = false;
    sharedTelemetry.batt_adc_mv = 0;
    sharedTelemetry.in_motion = false;
    sharedTelemetry.vibration_state = false;
    sharedTelemetry.tamper_alarm = false;
    sharedTelemetry.tamper_warn_count = 0;
    sharedTelemetry.wifi_rssi = -100;
    sharedTelemetry.power_state = true;
    sharedTelemetry.locked_state = true; // Fail-safe default
    sharedTelemetry.session_state = "LOCKED";
    sharedTelemetry.time_left_s = 0;
    sharedTelemetry.ota_status = "idle";
    sharedTelemetry.ota_progress = 0;
    sharedTelemetry.ota_last_error = "";

    sharedTelemetry.gf.on = havePersistedGeofence && persistedGeofenceEnabled;
    sharedTelemetry.gf.available = false;
    sharedTelemetry.gf.inside = true;
    sharedTelemetry.gf.dist_m = 0.0;
    sharedTelemetry.gf.radius_m = havePersistedGeofence
        ? persistedGeofenceRadius
        : GEOFENCE_RADIUS_M;
    sharedTelemetry.gf.center_lat = havePersistedGeofence
        ? persistedGeofenceLat
        : NAN;
    sharedTelemetry.gf.center_lng = havePersistedGeofence
        ? persistedGeofenceLng
        : NAN;
    xSemaphoreGive(stateMutex);

    // Initialize GPS UART with 1024-byte RX buffer
    GPSSerial.setRxBufferSize(1024);
    GPSSerial.begin(GPS_BAUD, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
    Serial.println("[Sensors] GPS Serial initialized.");
    // configureM8NGPS(); // Disabled u-blox UBX overrides for universal NMEA module compatibility

    // Initialize I2C
    Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN, 400000);
    
    // Initialize main MPU6500 chip
    if (init6Axis()) {
        mpuOK = true;
        Serial.println("[Sensors] MPU6500 6-Axis IMU initialized successfully.");
        
        // Gyro bias is a property of the chip at this temperature, so it is
        // always re-measured at boot. The LEVEL reference is different: it
        // describes how the board is mounted, so it is restored from NVS
        // rather than re-derived from whatever pose the chair booted in.
        Serial.println("[Sensors] Measuring gyro bias...");
        float sumGX = 0, sumGY = 0, sumGZ = 0;
        float sumPitch = 0, sumRoll = 0;
        int count = 0;
        for (int i = 0; i < 150; i++) {
            float ax, ay, az, gx, gy, gz;
            if (read6Axis(ax, ay, az, gx, gy, gz)) {
                const float accelMag = sqrtf(ax * ax + ay * ay + az * az);
                const float maxGyro = max(abs(gx), max(abs(gy), abs(gz)));
                if (accelMag <= 0.90f || accelMag >= 1.10f || maxGyro >= 5.0f) {
                    delay(10);
                    continue;
                }
                float pitchAcc = atan2(ay, sqrt(ax * ax + az * az)) * 180.0 / PI;
                float rollAcc  = atan2(-ax, az) * 180.0 / PI;
                sumGX += gx;
                sumGY += gy;
                sumGZ += gz;
                sumPitch += pitchAcc;
                sumRoll += rollAcc;
                count++;
            }
            delay(10);
        }
        if (count >= 100) {
            gyroBiasX = sumGX / count;
            gyroBiasY = sumGY / count;
            gyroBiasZ = sumGZ / count;
            Serial.printf("[Sensors] Gyro bias measured (%d stationary samples).\n", count);
        } else {
            gyroBiasX = gyroBiasY = gyroBiasZ = 0.0f;
            Serial.printf("[Sensors] Gyro bias skipped: only %d stationary samples.\n", count);
        }

        float storedPitch = 0.0f, storedRoll = 0.0f;
        float storedGbX = 0.0f, storedGbY = 0.0f, storedGbZ = 0.0f;
        if (loadImuLevelOffsets(storedPitch, storedRoll, storedGbX, storedGbY, storedGbZ)) {
            pitchOffset = storedPitch;
            rollOffset = storedRoll;
            // The stored bias came from a verified-still capture, so it beats
            // a boot measurement taken while the chair was being handled —
            // which is precisely when the boot one silently falls back to 0.
            gyroBiasX = storedGbX;
            gyroBiasY = storedGbY;
            gyroBiasZ = storedGbZ;
            imuLevelCalibrated = true;
            Serial.printf(
                "[Sensors] Level restored: pitch %.2f, roll %.2f deg; gyro bias %.2f, %.2f, %.2f deg/s.\n",
                pitchOffset, rollOffset, gyroBiasX, gyroBiasY, gyroBiasZ
            );
        } else if (count >= 100) {
            // Nothing stored yet — seed from this boot so a fresh board is
            // roughly right, but do NOT mark it calibrated: the pose at boot
            // is a guess, and the console should still ask for a real
            // calibration on a level surface.
            pitchOffset = sumPitch / count;
            rollOffset = sumRoll / count;
            imuLevelCalibrated = false;
            Serial.println("[Sensors] No stored level reference — seeded from boot pose (uncalibrated).");
        } else {
            pitchOffset = rollOffset = 0.0f;
            imuLevelCalibrated = false;
            Serial.println("[Sensors] No level reference and no stationary samples — angles are raw.");
        }
        lastFusionMicros = micros();
    } else {
        mpuOK = false;
        Serial.println("[Sensors] IMU initialization FAILED. Proceeding with mock IMU.");
    }

    // Use the configured OneWire pin only. Scanning arbitrary GPIOs can disturb
    // the battery ADC, status LED, UART, and future safety interfaces.
    delay(150); // Power rail stabilization delay
    pinMode(ONEWIRE_PIN, INPUT_PULLUP);
    oneWire.begin(ONEWIRE_PIN);
    tempSensors.begin();
    dsOK = tempSensors.getDeviceCount() > 0;
    if (dsOK && tempSensors.getAddress(battAddress, 0)) {
        battSensorOK = true;
        tempSensors.setResolution(battAddress, 10);
        tempSensors.setWaitForConversion(false);
        Serial.printf("[Sensors] DS18B20 found on configured GPIO %d.\n", ONEWIRE_PIN);
    }

    if (!dsOK) {
        Serial.printf("[Sensors] No DS18B20 found on configured GPIO %d.\n", ONEWIRE_PIN);
    }

    pinMode(BATT_ADC_PIN, INPUT);
    analogSetPinAttenuation(BATT_ADC_PIN, ADC_11db);
}

// GPS task: physical NEO-M8N data is authoritative whenever a fresh fix is
// available. Without a fix, the ESP32 emits a bounded, explicitly tagged
// indoor fallback around the last physical fix (or the configured default).
void gpsTask(void *pvParameters) {
    esp_task_wdt_add(NULL);
    Serial.println("[Tasks] GPS Task started.");

    char nmeaLine[128] = {0};
    size_t nmeaLength = 0;
    const uint32_t FALLBACK_UPDATE_MS = 200;
    const double METERS_PER_DEGREE_LAT = 111320.0;
    const double DEFAULT_FALLBACK_LAT = 24.8601;
    const double DEFAULT_FALLBACK_LNG = 67.0637;

    double fallbackAnchorLat = DEFAULT_FALLBACK_LAT;
    double fallbackAnchorLng = DEFAULT_FALLBACK_LNG;
    float fallbackAngleRad = 0.0f;
    uint32_t fallbackLastUpdateMs = millis();
    uint32_t fallbackAnchorRevision = 0;
    bool physicalFixActive = false;

    // Resume from the last real position this chair reported, so a unit
    // powered on indoors shows where it actually is instead of a default.
    double storedFixLat = NAN;
    double storedFixLng = NAN;
    if (loadLastKnownFix(storedFixLat, storedFixLng)) {
        fallbackAnchorLat = storedFixLat;
        fallbackAnchorLng = storedFixLng;
        xSemaphoreTake(stateMutex, portMAX_DELAY);
        sharedTelemetry.gps_lat = storedFixLat;
        sharedTelemetry.gps_lng = storedFixLng;
        sharedTelemetry.gps_fallback_anchor_lat = storedFixLat;
        sharedTelemetry.gps_fallback_anchor_lng = storedFixLng;
        xSemaphoreGive(stateMutex);
        Serial.printf(
            "[GPS] Restored last known position %.6f, %.6f from NVS (no fix yet).\n",
            storedFixLat,
            storedFixLng
        );
    } else {
        Serial.println("[GPS] No stored position — using configured default until first fix.");
    }

    // Throttle NVS writes: at most once a minute, and only after real movement.
    const uint32_t LAST_FIX_SAVE_INTERVAL_MS = 60000;
    const double LAST_FIX_SAVE_MIN_MOVE_M = 10.0;
    uint32_t lastFixSavedAtMs = 0;
    double lastFixSavedLat = storedFixLat;
    double lastFixSavedLng = storedFixLng;
    float filteredPhysicalSpeedKmh = 0.0f;
    uint8_t geofenceOutsideFixes = 0;
    uint8_t geofenceInsideFixes = 0;

    int rxCandidates[] = { GPS_RX_PIN, (GPS_RX_PIN == 18 ? 17 : 18), 4, 16 };
    int txCandidates[] = { GPS_TX_PIN, (GPS_TX_PIN == 17 ? 18 : 17), 16, 4 };
    const long baudCandidates[] = { 115200, 9600, 38400, 460800, 4800 };
    const size_t pinCandidateCount = sizeof(rxCandidates) / sizeof(rxCandidates[0]);
    const size_t baudCandidateCount = sizeof(baudCandidates) / sizeof(baudCandidates[0]);
    int currentPinIdx = 0;
    int currentBaudIdx = 0;
    bool lockedGpsHardware = false;
    uint8_t validNmeaStreak = 0;
    uint32_t lastUbxRecoveryMs = 0;
    UbxFrameParser ubxParser;

    // Send Wakeup & NMEA output enable pulse to wake new GPS modules from factory sleep
    auto sendGpsWakeupPulse = []() {
        GPSSerial.write("\r\n\r\n");
        GPSSerial.write("$PMTK101*32\r\n");                  // PMTK Hot Start / Wakeup
        GPSSerial.write("$PUBX,40,GGA,0,1,0,0,0,0*5B\r\n");  // Enable UBX/NMEA GGA sentence
        GPSSerial.write("$PUBX,40,RMC,0,1,0,0,0,0*46\r\n");  // Enable UBX/NMEA RMC sentence
        GPSSerial.write("$PUBX,40,GLL,0,1,0,0,0,0*5D\r\n");  // Enable UBX/NMEA GLL sentence
        GPSSerial.write("$PUBX,40,VTG,0,1,0,0,0,0*5F\r\n");  // Enable UBX/NMEA VTG sentence
        GPSSerial.flush();
    };

    GPSSerial.begin(baudCandidates[currentBaudIdx], SERIAL_8N1, rxCandidates[currentPinIdx], txCandidates[currentPinIdx]);
    Serial.printf("[Sensors] Starting GPS Task monitoring on RX=GPIO%d, TX=GPIO%d at %ld baud...\n",
                  rxCandidates[currentPinIdx], txCandidates[currentPinIdx], baudCandidates[currentBaudIdx]);
    sendGpsWakeupPulse();
    pollUbxVersion();

    uint32_t candidateStartedMs = millis();
    uint32_t lastValidNmeaMs = 0;
    uint32_t lastDiagReportMs = millis();
    uint32_t lastRawSentenceLogMs = 0;
    uint64_t totalBytesReceived = 0;

    while (true) {
        esp_task_wdt_reset();
        if (GPSSerial.available() > 0) {
            while (GPSSerial.available() > 0) {
                const uint8_t rawByte = static_cast<uint8_t>(GPSSerial.read());
                const char c = static_cast<char>(rawByte);
                totalBytesReceived++;

                const bool validUbx = ubxParser.feed(rawByte);
                if (
                    validUbx &&
                    !lockedGpsHardware &&
                    (lastUbxRecoveryMs == 0 || millis() - lastUbxRecoveryMs > 60000)
                ) {
                    Serial.printf(
                        "\n[Sensors] Checksum-valid UBX frame %02X/%02X on RX=GPIO%d, TX=GPIO%d at %ld baud.\n",
                        ubxParser.lastMessageClass,
                        ubxParser.lastMessageId,
                        rxCandidates[currentPinIdx],
                        txCandidates[currentPinIdx],
                        baudCandidates[currentBaudIdx]
                    );
                    lastUbxRecoveryMs = millis();
                    recoverUbxGpsToNmea(rxCandidates[currentPinIdx], txCandidates[currentPinIdx]);
                    currentBaudIdx = 0;
                    nmeaLength = 0;
                    validNmeaStreak = 0;
                    ubxParser.reset();
                    candidateStartedMs = millis();
                    continue;
                }

                if (c == '$') {
                    nmeaLength = 0;
                    nmeaLine[nmeaLength++] = c;
                } else if (c == '\n') {
                    nmeaLine[nmeaLength] = '\0';
                    for (size_t i = 0; i < nmeaLength; i++) {
                        gps.encode(nmeaLine[i]);
                    }
                    if (nmeaLength > 0) {
                        gps.encode('\r');
                        gps.encode('\n');
                    }
                    const bool validNmea = hasValidNmeaChecksum(nmeaLine);
                    if (validNmea) {
                        lastValidNmeaMs = millis();
                        if (
                            millis() - lastRawSentenceLogMs >= 1000
                            && (strstr(nmeaLine, "GGA") != nullptr || strstr(nmeaLine, "RMC") != nullptr)
                        ) {
                            Serial.printf("[GPS-NMEA] %s\n", nmeaLine);
                            lastRawSentenceLogMs = millis();
                        }
                        if (!lockedGpsHardware) {
                            validNmeaStreak++;
                            if (validNmeaStreak >= 2) {
                                lockedGpsHardware = true;
                                Serial.printf(
                                    "\n[Sensors] GPS UART locked after validated NMEA on RX=GPIO%d, TX=GPIO%d at %ld baud.\n",
                                    rxCandidates[currentPinIdx],
                                    txCandidates[currentPinIdx],
                                    baudCandidates[currentBaudIdx]
                                );
                            }
                        }
                    } else if (!lockedGpsHardware) {
                        validNmeaStreak = 0;
                    }

                    if (validNmea && nmeaLength > 0) {
                        xSemaphoreTake(stateMutex, portMAX_DELAY);
                        sharedTelemetry.gps_last_data_ms = millis();
                        if (strstr(nmeaLine, "GGA") != nullptr) {
                            strncpy(sharedTelemetry.gps_nmea_gga, nmeaLine, sizeof(sharedTelemetry.gps_nmea_gga) - 1);
                            sharedTelemetry.gps_nmea_gga[sizeof(sharedTelemetry.gps_nmea_gga) - 1] = '\0';
                        } else if (strstr(nmeaLine, "RMC") != nullptr) {
                            strncpy(sharedTelemetry.gps_nmea_rmc, nmeaLine, sizeof(sharedTelemetry.gps_nmea_rmc) - 1);
                            sharedTelemetry.gps_nmea_rmc[sizeof(sharedTelemetry.gps_nmea_rmc) - 1] = '\0';
                        } else {
                            if (sharedTelemetry.gps_nmea_gga[0] == '\0') {
                                strncpy(sharedTelemetry.gps_nmea_gga, nmeaLine, sizeof(sharedTelemetry.gps_nmea_gga) - 1);
                                sharedTelemetry.gps_nmea_gga[sizeof(sharedTelemetry.gps_nmea_gga) - 1] = '\0';
                            }
                            if (sharedTelemetry.gps_nmea_rmc[0] == '\0') {
                                strncpy(sharedTelemetry.gps_nmea_rmc, nmeaLine, sizeof(sharedTelemetry.gps_nmea_rmc) - 1);
                                sharedTelemetry.gps_nmea_rmc[sizeof(sharedTelemetry.gps_nmea_rmc) - 1] = '\0';
                            }
                        }
                        xSemaphoreGive(stateMutex);
                    }
                    nmeaLength = 0;
                } else if (c != '\r' && nmeaLength > 0 && nmeaLength < sizeof(nmeaLine) - 1) {
                    nmeaLine[nmeaLength++] = c;
                }
            }
        } else {
            vTaskDelay(pdMS_TO_TICKS(50));
        }

        const uint32_t now = millis();
        if (now - lastDiagReportMs > 3000) {
            Serial.printf(
                "\n[GPS-RAW-DIAG] Total Bytes Read: %llu | Valid NMEA: %lu | Locked: %s | RX=GPIO%d, TX=GPIO%d at %ld baud\n",
                static_cast<unsigned long long>(totalBytesReceived),
                static_cast<unsigned long>(gps.passedChecksum()),
                lockedGpsHardware ? "YES" : "NO",
                rxCandidates[currentPinIdx],
                txCandidates[currentPinIdx],
                baudCandidates[currentBaudIdx]
            );
            lastDiagReportMs = now;
        }

        if (lockedGpsHardware && lastValidNmeaMs > 0 && now - lastValidNmeaMs > 8000) {
            lockedGpsHardware = false;
            validNmeaStreak = 0;
            candidateStartedMs = now;
            Serial.println("[Sensors] Valid NMEA stream timed out. Reopening GPS UART scan.");
        }

        // ---- Retained NMEA must not outlive the receiver --------------------
        // The buffers below are only ever written from a checksum-valid
        // sentence, so nothing here is invented. But they were only cleared at
        // boot: unplug the module and the LAST sentence it emitted stayed
        // frozen in the shared state and kept uploading once a second, so the
        // console showed a "snapshot" of a receiver that was no longer there.
        //
        // A missing receiver has no reading to report, so report none: empty
        // the sentences and blank the derived counters. The web app renders
        // that absence as a wiring/power problem instead of stale text.
        if (sharedTelemetry.gps_nmea_gga[0] != '\0' || sharedTelemetry.gps_nmea_rmc[0] != '\0') {
            const uint32_t lastData = sharedTelemetry.gps_last_data_ms;
            if (lastData == 0 || now - lastData > GPS_DATA_STALE_MS) {
                xSemaphoreTake(stateMutex, portMAX_DELAY);
                sharedTelemetry.gps_nmea_gga[0] = '\0';
                sharedTelemetry.gps_nmea_rmc[0] = '\0';
                sharedTelemetry.gps_sats = 0;
                sharedTelemetry.gps_hdop = NAN;
                xSemaphoreGive(stateMutex);
                Serial.printf(
                    "[Sensors] No GPS bytes for %lus — clearing retained NMEA (receiver absent?).\n",
                    static_cast<unsigned long>(GPS_DATA_STALE_MS / 1000)
                );
            }
        }

        // Move on even if a wrong baud produces continuous garbage bytes.
        if (!lockedGpsHardware && now - candidateStartedMs > 4000) {
            currentBaudIdx = (currentBaudIdx + 1) % baudCandidateCount;
            if (currentBaudIdx == 0) {
                currentPinIdx = (currentPinIdx + 1) % pinCandidateCount;
            }
            GPSSerial.begin(
                baudCandidates[currentBaudIdx],
                SERIAL_8N1,
                rxCandidates[currentPinIdx],
                txCandidates[currentPinIdx]
            );
            nmeaLength = 0;
            validNmeaStreak = 0;
            ubxParser.reset();
            candidateStartedMs = now;
            Serial.printf(
                "[Sensors] No validated NMEA. Trying RX=GPIO%d TX=GPIO%d at %ld baud...\n",
                rxCandidates[currentPinIdx],
                txCandidates[currentPinIdx],
                baudCandidates[currentBaudIdx]
            );
            sendGpsWakeupPulse();
            pollUbxVersion();
        }

        const double candidateLat = gps.location.lat();
        const double candidateLng = gps.location.lng();
        const bool coordinatesValid =
            isfinite(candidateLat) &&
            isfinite(candidateLng) &&
            candidateLat >= -90.0 &&
            candidateLat <= 90.0 &&
            candidateLng >= -180.0 &&
            candidateLng <= 180.0 &&
            !(candidateLat == 0.0 && candidateLng == 0.0);
        const bool fixQualityValid =
            gps.satellites.isValid() &&
            gps.satellites.value() >= GPS_MIN_FIX_SATELLITES &&
            gps.hdop.isValid() &&
            gps.hdop.hdop() > 0.0f &&
            gps.hdop.hdop() <= GPS_MAX_FIX_HDOP;
        const bool hasFreshFix =
            gps.location.isValid() &&
            gps.location.age() <= GPS_FIX_TIMEOUT_MS &&
            coordinatesValid &&
            fixQualityValid;

        xSemaphoreTake(stateMutex, portMAX_DELAY);
        if (sharedTelemetry.gps_fallback_anchor_revision != fallbackAnchorRevision) {
            fallbackAnchorLat = sharedTelemetry.gps_fallback_anchor_lat;
            fallbackAnchorLng = sharedTelemetry.gps_fallback_anchor_lng;
            fallbackAnchorRevision = sharedTelemetry.gps_fallback_anchor_revision;
            fallbackAngleRad = 0.0f;
            fallbackLastUpdateMs = now;
        }

        sharedTelemetry.gps_chars_processed = gps.charsProcessed();
        sharedTelemetry.gps_sentences_valid = gps.passedChecksum();
        sharedTelemetry.gps_checksum_failures = gps.failedChecksum();

        if (gps.satellites.isValid()) {
            sharedTelemetry.gps_sats = gps.satellites.value();
        }
        if (gps.hdop.isValid()) {
            sharedTelemetry.gps_hdop = gps.hdop.hdop();
        }
        if (gps.course.isValid()) {
            sharedTelemetry.gps_course_deg = gps.course.deg();
        }
        if (gps.altitude.isValid()) {
            sharedTelemetry.gps_altitude_m = gps.altitude.meters();
        }

        sharedTelemetry.gps_fix = hasFreshFix;
        if (hasFreshFix) {
            const float rawSpeedKmh = gps.speed.isValid() && isfinite(gps.speed.kmph())
                ? max(0.0f, static_cast<float>(gps.speed.kmph()))
                : 0.0f;
            filteredPhysicalSpeedKmh = physicalFixActive
                ? 0.35f * rawSpeedKmh + 0.65f * filteredPhysicalSpeedKmh
                : rawSpeedKmh;
            sharedTelemetry.gps_lat = candidateLat;
            sharedTelemetry.gps_lng = candidateLng;
            sharedTelemetry.gps_speed_kmh = filteredPhysicalSpeedKmh;
            sharedTelemetry.gps_physical_lat = sharedTelemetry.gps_lat;
            sharedTelemetry.gps_physical_lng = sharedTelemetry.gps_lng;
            sharedTelemetry.gps_physical_speed_kmh = sharedTelemetry.gps_speed_kmh;
            sharedTelemetry.gps_physical_course_deg =
                gps.course.isValid() ? gps.course.deg() : NAN;
            sharedTelemetry.gps_physical_altitude_m =
                gps.altitude.isValid() ? gps.altitude.meters() : NAN;
            sharedTelemetry.gps_last_fix_ms = now - gps.location.age();
            sharedTelemetry.gps_simulated = false;

            fallbackAnchorLat = sharedTelemetry.gps_lat;
            fallbackAnchorLng = sharedTelemetry.gps_lng;
            sharedTelemetry.gps_fallback_anchor_lat = fallbackAnchorLat;
            sharedTelemetry.gps_fallback_anchor_lng = fallbackAnchorLng;
            fallbackLastUpdateMs = now;

            // Persist the last real position so the next boot — possibly
            // indoors with no satellites — resumes from here. Throttled to
            // spare the flash: once a minute, and only after real movement.
            const bool neverSaved = !isfinite(lastFixSavedLat) || !isfinite(lastFixSavedLng);
            const double movedM = neverSaved
                ? LAST_FIX_SAVE_MIN_MOVE_M + 1.0
                : calculateDistance(
                      fallbackAnchorLat, fallbackAnchorLng,
                      lastFixSavedLat, lastFixSavedLng
                  );
            if ((lastFixSavedAtMs == 0 || now - lastFixSavedAtMs >= LAST_FIX_SAVE_INTERVAL_MS)
                && movedM >= LAST_FIX_SAVE_MIN_MOVE_M) {
                if (saveLastKnownFix(fallbackAnchorLat, fallbackAnchorLng)) {
                    lastFixSavedAtMs = now;
                    lastFixSavedLat = fallbackAnchorLat;
                    lastFixSavedLng = fallbackAnchorLng;
                }
            }

            if (!physicalFixActive) {
                Serial.printf(
                    "[GPS] Physical fix acquired. Using NEO-M8N at %.6f, %.6f.\n",
                    sharedTelemetry.gps_lat,
                    sharedTelemetry.gps_lng
                );
            }
            physicalFixActive = true;

            if (sharedTelemetry.gf.on) {
                const double dist = calculateDistance(
                    sharedTelemetry.gps_lat,
                    sharedTelemetry.gps_lng,
                    sharedTelemetry.gf.center_lat,
                    sharedTelemetry.gf.center_lng
                );
                sharedTelemetry.gf.dist_m = dist;
                sharedTelemetry.gf.available = true;

                const float exitBoundary =
                    sharedTelemetry.gf.radius_m + GEOFENCE_HYSTERESIS_M;
                const float enterBoundary = max(
                    0.0f,
                    sharedTelemetry.gf.radius_m - GEOFENCE_HYSTERESIS_M
                );
                if (dist > exitBoundary) {
                    geofenceOutsideFixes++;
                    geofenceInsideFixes = 0;
                    if (geofenceOutsideFixes >= GEOFENCE_CONFIRM_FIXES) {
                        sharedTelemetry.gf.inside = false;
                        geofenceOutsideFixes = GEOFENCE_CONFIRM_FIXES;
                    }
                } else if (dist < enterBoundary) {
                    geofenceInsideFixes++;
                    geofenceOutsideFixes = 0;
                    if (geofenceInsideFixes >= GEOFENCE_CONFIRM_FIXES) {
                        sharedTelemetry.gf.inside = true;
                        geofenceInsideFixes = GEOFENCE_CONFIRM_FIXES;
                    }
                } else {
                    geofenceOutsideFixes = 0;
                    geofenceInsideFixes = 0;
                }
            }
        } else {
            if (physicalFixActive) {
                Serial.printf(
                    "[GPS] Physical fix lost. Display continuity anchored at %.6f, %.6f.\n",
                    fallbackAnchorLat,
                    fallbackAnchorLng
                );
                fallbackLastUpdateMs = now;
            }
            physicalFixActive = false;
            sharedTelemetry.gps_simulated = true;
            sharedTelemetry.gps_physical_lat = NAN;
            sharedTelemetry.gps_physical_lng = NAN;
            sharedTelemetry.gps_physical_speed_kmh = 0.0f;
            sharedTelemetry.gps_physical_course_deg = NAN;
            sharedTelemetry.gps_physical_altitude_m = NAN;
            sharedTelemetry.gf.available = false;
            geofenceOutsideFixes = 0;
            geofenceInsideFixes = 0;

            if (now - fallbackLastUpdateMs >= FALLBACK_UPDATE_MS) {
                const float elapsedSeconds = (now - fallbackLastUpdateMs) / 1000.0f;
                fallbackLastUpdateMs = now;

                // Drift rate for the POSITION wander only. It is deliberately
                // not published as speed: the wander exists so the map stays
                // continuous indoors, whereas speed is a measurement and must
                // never be invented. Ground truth for "is it moving" indoors
                // comes from the IMU (in_motion), which works without GNSS.
                const float driftMps = (0.3f + 0.2f * sinf(now * 0.00035f)) / 3.6f;
                const float radiusM = 3.0f + 2.0f * sinf(now * 0.00019f + 1.3f);
                const float angularVelocity = driftMps / max(radiusM, 1.0f);
                fallbackAngleRad = fmodf(
                    fallbackAngleRad + angularVelocity * elapsedSeconds,
                    2.0f * PI
                );

                const double northOffsetM = radiusM * sinf(fallbackAngleRad);
                const double eastOffsetM = radiusM * cosf(fallbackAngleRad);
                const double metersPerDegreeLng =
                    METERS_PER_DEGREE_LAT * cos(fallbackAnchorLat * DEG_TO_RAD);

                sharedTelemetry.gps_lat =
                    fallbackAnchorLat + northOffsetM / METERS_PER_DEGREE_LAT;
                sharedTelemetry.gps_lng =
                    fallbackAnchorLng + eastOffsetM / metersPerDegreeLng;
                // Speed, course and altitude are MEASUREMENTS. Without a fix
                // they are unknown, so they are reported as unknown (NAN ->
                // null in telemetry) rather than derived from the display
                // wander. Previously this published the wander's own rate as
                // if the chair were really creeping along at ~0.3 km/h.
                sharedTelemetry.gps_speed_kmh = NAN;
                sharedTelemetry.gps_course_deg = NAN;
                sharedTelemetry.gps_altitude_m = NAN;
            }
        }
        xSemaphoreGive(stateMutex);

        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

// Complementary/AHRS filter for IMU at 50 Hz
void readIMU() {
    if (!mpuOK) {
        const uint32_t now = millis();
        if (now - lastImuRecoveryAttemptMs >= 2000) {
            lastImuRecoveryAttemptMs = now;
            if (init6Axis()) {
                mpuOK = true;
                imuReadFailures = 0;
                lastFusionMicros = micros();
                Serial.println("[Sensors] MPU runtime recovery succeeded.");
                return;
            }
        }
        xSemaphoreTake(stateMutex, portMAX_DELAY);
        sharedTelemetry.pitch = NAN;
        sharedTelemetry.roll = NAN;
        sharedTelemetry.yaw = NAN;
        sharedTelemetry.tilt = NAN;
        sharedTelemetry.imu_accel_x_g = NAN;
        sharedTelemetry.imu_accel_y_g = NAN;
        sharedTelemetry.imu_accel_z_g = NAN;
        sharedTelemetry.imu_gyro_x_dps = NAN;
        sharedTelemetry.imu_gyro_y_dps = NAN;
        sharedTelemetry.imu_gyro_z_dps = NAN;
        sharedTelemetry.imu_last_sample_ms = 0;
        sharedTelemetry.imu_valid = false;
        sharedTelemetry.imu_read_failures = imuReadFailures;
        sharedTelemetry.vibration_state = false;
        xSemaphoreGive(stateMutex);
        return;
    }

    float ax, ay, az, gx, gy, gz;
    if (read6Axis(ax, ay, az, gx, gy, gz)) {
        imuReadFailures = 0;
        float pitchAcc = atan2(ay, sqrt(ax * ax + az * az)) * 180.0 / PI;
        float rollAcc  = atan2(-ax, az) * 180.0 / PI;

        float calGX = gx - gyroBiasX;
        float calGY = gy - gyroBiasY;
        float calGZ = gz - gyroBiasZ;
        calibratedGyroRateDps = max(abs(calGX), max(abs(calGY), abs(calGZ)));
        float pitchAccCal = pitchAcc - pitchOffset;
        float rollAccCal  = rollAcc  - rollOffset;

        unsigned long nowMicros = micros();
        float dt = (lastFusionMicros == 0) ? 0.02 : (nowMicros - lastFusionMicros) / 1000000.0;
        lastFusionMicros = nowMicros;
        if (dt <= 0 || dt > 0.5) dt = 0.02;

        // Complementary filter for Pitch and Roll
        g_pitch_cf = 0.98f * (g_pitch_cf + calGX * dt) + 0.02f * pitchAccCal;
        g_roll_cf  = 0.98f * (g_roll_cf  + calGY * dt) + 0.02f * rollAccCal;

        // Relative Yaw integration
        g_yaw_cf += calGZ * dt;

        if (g_yaw_cf > 180.0) g_yaw_cf -= 360.0;
        if (g_yaw_cf < -180.0) g_yaw_cf += 360.0;

        // Convert acceleration from G to m/s^2
        float accX = ax * 9.80665f;
        float accY = ay * 9.80665f;
        float accZ = az * 9.80665f;
        float gyroMaxRate = max(abs(gx), max(abs(gy), abs(gz)));

        float gMag = sqrt(accX * accX + accY * accY + accZ * accZ);
        // Orientation for safety comes from the complementary filter instead
        // of the instantaneous acceleration vector, which is distorted by
        // potholes, curb impacts, and acceleration.
        const float tiltAngle = min(
            180.0f,
            sqrtf(g_pitch_cf * g_pitch_cf + g_roll_cf * g_roll_cf)
        );

        // Vibration/Shock Detection (accelerometer deviation from 1G gravity)
        float accelDev = abs(gMag - 9.80665f);
        bool rawMotion = (accelDev >= TAMPER_MPU_ACCEL_THRESH || gyroMaxRate >= TAMPER_MPU_GYRO_THRESH);
        
        static int motionDebounceCount = 0;
        bool imuMotionDetected = false;
        if (rawMotion) {
            motionDebounceCount++;
            if (motionDebounceCount >= 5) { // 5 consecutive samples at 50 Hz = 100 ms of sustained vibration/rotation
                imuMotionDetected = true;
                motionDebounceCount = 5; // cap to prevent overflow
            }
        } else {
            motionDebounceCount = 0;
        }

        // Motion/vibration estimation via micro-movements
        float accDiff = abs(gMag - lastAccMag);
        lastAccMag = gMag;
        smoothAccDiff = 0.95f * smoothAccDiff + 0.05f * accDiff;

        xSemaphoreTake(stateMutex, portMAX_DELAY);
        sharedTelemetry.imu_accel_x_g = ax;
        sharedTelemetry.imu_accel_y_g = ay;
        sharedTelemetry.imu_accel_z_g = az;
        sharedTelemetry.imu_gyro_x_dps = gx;
        sharedTelemetry.imu_gyro_y_dps = gy;
        sharedTelemetry.imu_gyro_z_dps = gz;
        sharedTelemetry.imu_last_sample_ms = millis();
        sharedTelemetry.imu_valid = true;
        sharedTelemetry.imu_read_failures = 0;
        sharedTelemetry.pitch = g_pitch_cf;
        sharedTelemetry.roll = g_roll_cf;
        sharedTelemetry.yaw = g_yaw_cf;
        sharedTelemetry.tilt = tiltAngle;
        sharedTelemetry.vibration_state = imuMotionDetected;
        xSemaphoreGive(stateMutex);
    } else {
        imuReadFailures++;
        xSemaphoreTake(stateMutex, portMAX_DELAY);
        sharedTelemetry.imu_read_failures = imuReadFailures;
        if (imuReadFailures >= IMU_FAILURE_LIMIT) {
            sharedTelemetry.imu_valid = false;
            sharedTelemetry.vibration_state = false;
        }
        xSemaphoreGive(stateMutex);

        if (imuReadFailures >= IMU_FAILURE_LIMIT) {
            mpuOK = false;
            Serial.printf(
                "[Safety] MPU read failed %lu consecutive times; sensor marked offline.\n",
                static_cast<unsigned long>(imuReadFailures)
            );
        }
    }
}


// 20 Hz poll task (IMU + Analog + Switches)
void sensorPollTask(void *pvParameters) {
    esp_task_wdt_add(NULL);
    TickType_t lastWakeTime = xTaskGetTickCount();
    uint32_t loopCount = 0;
    uint8_t motionEvidenceSamples = 0;
    uint32_t motionHoldUntilMs = 0;
    bool previousMotionState = false;
    Serial.println("[Tasks] Sensor Poll Task (50Hz/20Hz) started.");

    while (true) {
        esp_task_wdt_reset();
        // Read IMU at 50 Hz (every cycle)
        readIMU();

        // Read other inputs at 20 Hz (every 2.5 cycles, approx 50 ms)
        if (++loopCount >= 2) {
            loopCount = 0;

            // Calibrated millivolt readings use the ESP32-S3 ADC calibration
            // path exposed by analogReadMilliVolts().
            uint32_t sumMv = 0;
            for (int i = 0; i < 16; i++) {
                sumMv += analogReadMilliVolts(BATT_ADC_PIN);
                delayMicroseconds(200);
            }
            const uint16_t adcMv = static_cast<uint16_t>(sumMv / 16U);
            const float v_batt_real = (adcMv / 1000.0f) * BATT_DIVIDER;
            const bool batteryValid =
                v_batt_real >= BATT_MIN_VALID_V
                && v_batt_real <= BATT_MAX_VALID_V;

            float pct_real =
                (v_batt_real - BATT_EMPTY_V) / (BATT_FULL_V - BATT_EMPTY_V) * 100.0f;
            pct_real = constrain(pct_real, 0.0f, 100.0f);

            float battV = v_batt_real;
            int battPct = (int)pct_real;

            // Display continuity is retained for current prototype units, but
            // batt_valid remains false so diagnostics expose the missing input.
#if ALLOW_BATTERY_DISPLAY_FALLBACK
            if (!batteryValid) {
                int simPct = 98 - (int)(millis() / 360000);
                if (simPct < 0) simPct = 0;
                battPct = simPct;
                battV = BATT_EMPTY_V
                    + (simPct / 100.0f) * (BATT_FULL_V - BATT_EMPTY_V);
            }
#endif

            xSemaphoreTake(stateMutex, portMAX_DELAY);
            const float physicalSpeed = sharedTelemetry.gps_physical_speed_kmh;
            const bool physicalFix = sharedTelemetry.gps_fix;
            xSemaphoreGive(stateMutex);

            // Display fallback speed must never affect a safety decision.
            // Confirm dynamic IMU evidence over multiple samples, then keep the
            // motion state briefly latched so controlled stops cannot chatter.
            const bool gpsMotion =
                physicalFix && physicalSpeed > STATIONARY_SPEED_KMH;
            const bool imuMotionEvidence =
                smoothAccDiff > MOTION_ACCEL_DELTA_MPS2
                || calibratedGyroRateDps > MOTION_GYRO_RATE_DPS;
            if (imuMotionEvidence) {
                if (motionEvidenceSamples < MOTION_CONFIRM_SAMPLES) {
                    motionEvidenceSamples++;
                }
                if (motionEvidenceSamples >= MOTION_CONFIRM_SAMPLES) {
                    motionHoldUntilMs = millis() + MOTION_HOLD_MS;
                }
            } else {
                motionEvidenceSamples = 0;
            }
            const bool imuMotionHeld =
                static_cast<int32_t>(motionHoldUntilMs - millis()) > 0;
            const bool isMoving = gpsMotion || imuMotionHeld;

            if (isMoving != previousMotionState) {
                Serial.printf(
                    "[Motion] %s | gps:%d speed:%.2f km/h imu-delta:%.3f m/s2 gyro:%.2f dps\n",
                    isMoving ? "MOVING" : "STATIONARY",
                    gpsMotion ? 1 : 0,
                    physicalSpeed,
                    smoothAccDiff,
                    calibratedGyroRateDps
                );
                previousMotionState = isMoving;
            }

            xSemaphoreTake(stateMutex, portMAX_DELAY);
            sharedTelemetry.in_motion = isMoving;
            sharedTelemetry.batt_v = battV;
            sharedTelemetry.batt_pct = battPct;
            sharedTelemetry.batt_valid = batteryValid;
            sharedTelemetry.batt_adc_mv = adcMv;
            sharedTelemetry.uptime_s = millis() / 1000;
            xSemaphoreGive(stateMutex);
        }

        vTaskDelayUntil(&lastWakeTime, pdMS_TO_TICKS(20)); // Exact 50 Hz period
    }
}

// 0.5 Hz temperature poll task (runs every 2000 ms)
void tempTask(void *pvParameters) {
    esp_task_wdt_add(NULL);
    Serial.println("[Tasks] Temperature Task (0.5Hz) started.");
    uint8_t invalidReadings = 0;
    uint8_t validReadings = 0;
    while (true) {
        esp_task_wdt_reset();
        float battT = NAN;

        // Recover only on the configured pin.
        if (!dsOK || !battSensorOK) {
            oneWire.begin(ONEWIRE_PIN);
            tempSensors.begin();
            dsOK = tempSensors.getDeviceCount() > 0;
            battSensorOK = dsOK && tempSensors.getAddress(battAddress, 0);
            if (battSensorOK) {
                tempSensors.setResolution(battAddress, 10);
                tempSensors.setWaitForConversion(false);
                Serial.printf(
                    "[Sensors] DS18B20 recovered on configured GPIO %d.\n",
                    ONEWIRE_PIN
                );
            }
        }

        if (dsOK && battSensorOK) {
            tempSensors.requestTemperatures();
            vTaskDelay(pdMS_TO_TICKS(200));
            esp_task_wdt_reset();
            const float tBatt = tempSensors.getTempC(battAddress);
            if (tBatt != DEVICE_DISCONNECTED_C && tBatt > -55.0f && tBatt < 125.0f) {
                battT = tBatt;
                invalidReadings = 0;
                if (validReadings < 3) validReadings++;
            } else {
                validReadings = 0;
                invalidReadings++;
                if (invalidReadings >= 3) {
                    dsOK = false;
                    battSensorOK = false;
                    Serial.println("[Safety] Battery temp probe disconnected at runtime.");
                }
            }
        }

        xSemaphoreTake(stateMutex, portMAX_DELAY);
        if (isfinite(battT)) {
            sharedTelemetry.temp_battery = battT;
            sharedTelemetry.temp_last_sample_ms = millis();
        }
        sharedTelemetry.temp_valid = validReadings >= 2;
        if (!sharedTelemetry.temp_valid && invalidReadings >= 3) {
            sharedTelemetry.temp_battery = NAN;
        }
        xSemaphoreGive(stateMutex);

        vTaskDelay(pdMS_TO_TICKS(800));
    }
}

bool areSafetySensorsHealthy() {
    if (stateMutex == NULL) return false;
    xSemaphoreTake(stateMutex, portMAX_DELAY);
    const uint32_t now = millis();
    const bool imuHealthy =
        sharedTelemetry.imu_valid
        && sharedTelemetry.imu_last_sample_ms > 0
        && now - sharedTelemetry.imu_last_sample_ms <= IMU_STALE_TIMEOUT_MS;
    const bool tempHealthy =
        sharedTelemetry.temp_valid
        && sharedTelemetry.temp_last_sample_ms > 0
        && now - sharedTelemetry.temp_last_sample_ms <= TEMP_STALE_TIMEOUT_MS;
    xSemaphoreGive(stateMutex);
    return imuHealthy && (!TEMP_SENSOR_REQUIRED || tempHealthy);
}


// Haversine distance calculation in meters
double calculateDistance(double lat1, double lng1, double lat2, double lng2) {
    double dLat = (lat2 - lat1) * PI / 180.0;
    double dLng = (lng2 - lng1) * PI / 180.0;
    double a = sin(dLat/2) * sin(dLat/2) +
               cos(lat1 * PI / 180.0) * cos(lat2 * PI / 180.0) *
               sin(dLng/2) * sin(dLng/2);
    double c = 2 * atan2(sqrt(a), sqrt(1-a));
    return 6371000.0 * c;
}
