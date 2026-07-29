#pragma once
#include <Arduino.h>

struct TelemetryData {
    uint32_t uptime_s;
    bool gps_fix;
    bool gps_simulated;
    double gps_fallback_anchor_lat;
    double gps_fallback_anchor_lng;
    uint32_t gps_fallback_anchor_revision;
    double gps_lat;
    double gps_lng;
    float gps_speed_kmh;
    double gps_physical_lat;
    double gps_physical_lng;
    float gps_physical_speed_kmh;
    float gps_physical_course_deg;
    float gps_physical_altitude_m;
    int gps_sats;
    float gps_hdop;
    float gps_course_deg;
    float gps_altitude_m;
    uint32_t gps_last_data_ms;
    uint32_t gps_last_fix_ms;
    uint32_t gps_chars_processed;
    uint32_t gps_sentences_valid;
    uint32_t gps_checksum_failures;
    char gps_nmea_gga[128];
    char gps_nmea_rmc[128];

    float pitch;
    float roll;
    float tilt;
    float yaw;
    float imu_accel_x_g;
    float imu_accel_y_g;
    float imu_accel_z_g;
    float imu_gyro_x_dps;
    float imu_gyro_y_dps;
    float imu_gyro_z_dps;
    uint32_t imu_last_sample_ms;
    bool imu_valid;
    uint32_t imu_read_failures;

    float temp_battery;
    bool temp_valid;
    uint32_t temp_last_sample_ms;

    float batt_v;
    int batt_pct;
    bool batt_valid;
    uint16_t batt_adc_mv;
    bool in_motion;
    bool vibration_state;
    int wifi_rssi;

    // OTA State tracking variables
    String ota_status;
    int ota_progress;
    String ota_last_error;

    // Anti-tamper (MPU6500 accelerometer-based shock monitoring, armed while LOCKED)
    bool tamper_alarm;       // true = continuous siren latched (4th strike)
    int  tamper_warn_count;  // number of tamper disturbances counted so far

    bool power_state;
    bool locked_state;
    String session_state;
    int time_left_s;

    // Geofence status
    struct Geofence {
        bool on;
        bool available;
        bool inside;
        float dist_m;
        float radius_m;
        double center_lat;
        double center_lng;
    } gf;
};

// Global shared state and synchronization
extern TelemetryData sharedTelemetry;
extern SemaphoreHandle_t stateMutex;
extern bool mpuOK;

// Initialization and FreeRTOS tasks
void initSensors();
void gpsTask(void *pvParameters);
void sensorPollTask(void *pvParameters);
void tempTask(void *pvParameters);

// Utility functions
double calculateDistance(double lat1, double lng1, double lat2, double lng2);
void configureM8NGPS();
bool areSafetySensorsHealthy();
bool saveGeofenceConfig(double lat, double lng, float radius, bool enabled);

/**
 * Define the chair's current pose as level and store it in NVS.
 * Refuses while moving or while grossly off-level; `resultMessage` carries the
 * reason either way so the operator console can show it verbatim.
 */
bool calibrateImuLevel(String &resultMessage);

/** True when pitch/roll are referenced to a stored level, not a boot guess. */
bool imuIsLevelCalibrated();
