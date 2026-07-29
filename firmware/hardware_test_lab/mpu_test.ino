#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>

// Exact I2C pins
#define I2C_SDA_PIN 21
#define I2C_SCL_PIN 22
#define MPU6050_ADDR 0x68

Adafruit_MPU6050 mpu;

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("--- MPU6050 IMU Standalone Test ---");

  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN, 400000);
  
  if (mpu.begin(MPU6050_ADDR, &Wire)) {
    Serial.println("MPU6050 found and initialized successfully!");
    mpu.setAccelerometerRange(MPU6050_RANGE_4_G);
    mpu.setGyroRange(MPU6050_RANGE_250_DEG);
    mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
  } else {
    Serial.println("MPU6050 initialization FAILED! Check I2C wiring (SDA=21, SCL=22).");
    while (1) { delay(10); }
  }
}

void loop() {
  sensors_event_t a, g, temp;
  mpu.getEvent(&a, &g, &temp);

  // Calculate pitch and roll from accelerometer data
  float pitch = atan2(a.acceleration.y, sqrt(a.acceleration.x * a.acceleration.x + a.acceleration.z * a.acceleration.z)) * 180.0 / PI;
  float roll = atan2(-a.acceleration.x, sqrt(a.acceleration.y * a.acceleration.y + a.acceleration.z * a.acceleration.z)) * 180.0 / PI;

  // Calculate total tilt from vertical
  float gMag = sqrt(a.acceleration.x * a.acceleration.x + a.acceleration.y * a.acceleration.y + a.acceleration.z * a.acceleration.z);
  float tilt = 0.0;
  if (gMag > 0.0) {
    float val = a.acceleration.z / gMag;
    if (val > 1.0) val = 1.0;
    else if (val < -1.0) val = -1.0;
    tilt = acos(val) * 180.0 / PI;
  }

  Serial.printf("Acc: X=%.2f Y=%.2f Z=%.2f m/s^2 | Gyro: X=%.2f Y=%.2f Z=%.2f rad/s | Tilt: Pitch=%.1f deg, Roll=%.1f deg, Total=%.1f deg\n",
                a.acceleration.x, a.acceleration.y, a.acceleration.z,
                g.gyro.x, g.gyro.y, g.gyro.z,
                pitch, roll, tilt);

  delay(200);
}
