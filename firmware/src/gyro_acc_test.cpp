/*
  =====================================================================
  MPU6500 6-Axis Diagnostic Lab — WebSocket Edition
  =====================================================================
  Real-time 3D wheelchair visualization and sensor diagnostic dashboard.
  Configures the MPU6500 with a 41Hz Digital Low Pass Filter (DLPF) to
  smooth out motor vibrations and mechanical noise.

  WIRING:
    MPU6500 VCC  -> 3.3V     GND -> GND
    MPU6500 SDA  -> GPIO 5   SCL -> GPIO 6
    Buzzer (+)   -> GPIO 13  Buzzer (-) -> GND
  =====================================================================
*/

#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <ESPAsyncWebServer.h>

// ---------------- Pin configuration ----------------
#define SDA_PIN               5
#define SCL_PIN               6
#define BUZZER_PIN            13
#define BUZZER_ACTIVE_LOW     false

// ---------------- Scale / Threshold configuration ----------------
#define TILT_THRESHOLD_DEG    30.0
#define BEEP_FAST_MS           150
#define SENSOR_INTERVAL_MS    50   // ~20Hz stream rate

// ---------------- WiFi Access Point credentials ----------------
const char* AP_SSID     = "ESP32-S3-Wheelchair-Test";
const char* AP_PASSWORD = "wheelchair123";

AsyncWebServer server(80);
AsyncWebSocket ws("/ws");

// ---------------- Shared live state ----------------
bool  g_mpuOk = false;
char  g_chipName[32] = "MPU6500";
bool  g_alarmActive = false;
unsigned long lastSensorRead = 0;
unsigned long lastBuzzerToggle = 0;
unsigned long lastWsCleanup = 0;
bool buzzerOn = false;

enum CalMode { CAL_NONE, CAL_ACCEL_GYRO };
volatile CalMode g_calMode = CAL_NONE;

// ---------------- 6-Axis state variables ----------------
float g_ax = 0, g_ay = 0, g_az = 0;
float g_gx = 0, g_gy = 0, g_gz = 0;
float g_pitch = 0, g_roll = 0, g_yaw = 0;

// Calibration offsets
float gyroBiasX = 0, gyroBiasY = 0, gyroBiasZ = 0;
float pitchOffset = 0, rollOffset = 0;
float calSumGX = 0, calSumGY = 0, calSumGZ = 0;
float calSumPitch = 0, calSumRoll = 0;
int   calCount = 0;
unsigned long lastFusionMicros = 0;

// ---------------- Buzzer Control ----------------
void buzzerWrite(bool on) {
  if (BUZZER_ACTIVE_LOW) {
    digitalWrite(BUZZER_PIN, on ? LOW : HIGH);
  } else {
    digitalWrite(BUZZER_PIN, on ? HIGH : LOW);
  }
}

void updateBuzzer() {
  unsigned long now = millis();
  if (g_calMode != CAL_NONE) {
    if (now - lastBuzzerToggle >= 80) {
      lastBuzzerToggle = now;
      buzzerOn = !buzzerOn;
      buzzerWrite(buzzerOn);
    }
    return;
  }
  
  if (!g_alarmActive) {
    if (buzzerOn) {
      buzzerOn = false;
      buzzerWrite(false);
    }
    return;
  }
  
  if (now - lastBuzzerToggle >= BEEP_FAST_MS) {
    lastBuzzerToggle = now;
    buzzerOn = !buzzerOn;
    buzzerWrite(buzzerOn);
  }
}

// ---------------- Direct I2C functions for MPU6500 ----------------
bool init6Axis() {
  // 1. Wake up MPU and set clock source to auto-select PLL
  Wire.beginTransmission(0x68);
  Wire.write(0x6B); // PWR_MGMT_1
  Wire.write(0x01); // Clock select Auto/PLL
  if (Wire.endTransmission() != 0) return false;
  delay(10);

  // 2. Configure Digital Low Pass Filter (DLPF) to 41Hz
  // This drastically filters out high-frequency noise from motors & chassis vibrations
  Wire.beginTransmission(0x68);
  Wire.write(0x1A); // CONFIG
  Wire.write(0x03); // Gyro DLPF = 41Hz
  Wire.endTransmission();

  Wire.beginTransmission(0x68);
  Wire.write(0x1D); // ACCEL_CONFIG_2
  Wire.write(0x03); // Accel DLPF = 41Hz
  Wire.endTransmission();

  // 3. Set Full Scale Ranges to +/-2g and +/-250 deg/s for max sensitivity
  Wire.beginTransmission(0x68);
  Wire.write(0x1C); // ACCEL_CONFIG
  Wire.write(0x00); // 2g Full Scale
  Wire.endTransmission();

  Wire.beginTransmission(0x68);
  Wire.write(0x1B); // GYRO_CONFIG
  Wire.write(0x00); // 250 deg/s Full Scale
  Wire.endTransmission();

  return true;
}

bool read6Axis(float &ax, float &ay, float &az, float &gx, float &gy, float &gz) {
  Wire.beginTransmission(0x68);
  Wire.write(0x3B); // ACCEL_XOUT_H
  if (Wire.endTransmission(false) != 0) return false;

  Wire.requestFrom(0x68, 14);
  if (Wire.available() < 14) return false;

  int16_t raw_ax = (Wire.read() << 8) | Wire.read();
  int16_t raw_ay = (Wire.read() << 8) | Wire.read();
  int16_t raw_az = (Wire.read() << 8) | Wire.read();
  Wire.read(); Wire.read(); // skip temp
  int16_t raw_gx = (Wire.read() << 8) | Wire.read();
  int16_t raw_gy = (Wire.read() << 8) | Wire.read();
  int16_t raw_gz = (Wire.read() << 8) | Wire.read();

  ax = raw_ax / 16384.0f;
  ay = raw_ay / 16384.0f;
  az = raw_az / 16384.0f;
  gx = raw_gx / 131.0f;
  gy = raw_gy / 131.0f;
  gz = raw_gz / 131.0f;

  return true;
}

// ---------------- Broadcast Telemetry ----------------
void broadcastTelemetry() {
  if (ws.count() == 0) return;

  char buf[360];
  snprintf(buf, sizeof(buf),
    "{\"ok\":%s,\"chipName\":\"%s\",\"calMode\":%u,"
    "\"ax\":%.3f,\"ay\":%.3f,\"az\":%.3f,"
    "\"gx\":%.2f,\"gy\":%.2f,\"gz\":%.2f,"
    "\"pitch\":%.2f,\"roll\":%.2f,\"yaw\":%.2f,"
    "\"alarm\":%s}",
    g_mpuOk ? "true" : "false",
    g_chipName,
    (uint8_t)g_calMode,
    g_ax, g_ay, g_az,
    g_gx, g_gy, g_gz,
    g_pitch, g_roll, g_yaw,
    g_alarmActive ? "true" : "false"
  );
  ws.textAll(buf);
}

// ---------------- Web page (Cleaned of Magnetometer) ----------------
const char PAGE_HTML[] PROGMEM = R"HTML(
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ESP32-S3 MPU6500 6-Axis Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #0f172a;
    font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, sans-serif;
    color: #f8fafc;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 24px 16px;
    min-height: 100vh;
  }
  h1 { 
    font-size: 24px; 
    font-weight: 700; 
    margin-bottom: 4px; 
    text-align: center;
    background: linear-gradient(135deg, #38bdf8, #818cf8);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  .subtitle {
    font-size: 14px;
    color: #64748b;
    margin-bottom: 24px;
  }

  .container {
    width: 100%;
    max-width: 960px;
    display: grid;
    grid-template-columns: 1fr;
    gap: 24px;
  }

  @media (min-width: 768px) {
    .container {
      grid-template-columns: 1fr 1fr;
    }
  }

  .card-3d {
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 16px;
    padding: 24px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 360px;
  }

  #stage {
    width: 100%;
    height: 280px;
    perspective: 900px;
  }
  #world {
    width: 100%; height: 100%;
    position: relative;
    transform-style: preserve-3d;
    display: flex; align-items: center; justify-content: center;
  }
  #floor {
    position: absolute;
    width: 320px; height: 320px;
    top: 50%; left: 50%;
    margin: -160px 0 0 -160px;
    background:
      repeating-linear-gradient(0deg, #334155 0 1px, transparent 1px 40px),
      repeating-linear-gradient(90deg, #334155 0 1px, transparent 1px 40px);
    background-color: rgba(30, 41, 59, 0.5);
    transform: rotateX(90deg) translateZ(-60px);
    border: 2px solid #475569;
    border-radius: 8px;
  }
  #chair {
    position: relative;
    width: 140px; height: 140px;
    transform-style: preserve-3d;
  }
  .part {
    position: absolute;
    background: #3b82f6;
    border: 1px solid #1d4ed8;
  }
  #seat   { width: 90px; height: 70px; left: 25px; top: 35px; transform: rotateX(90deg) translateZ(0px); background: #3b82f6; box-shadow: inset 0 0 10px rgba(0,0,0,0.5); }
  #back   { width: 90px; height: 60px; left: 25px; top: -25px; transform-origin: bottom; background: #2563eb; }
  #wheelL { width: 60px; height: 60px; left: -10px; top: 40px; border-radius: 50%; background: #1e293b; transform: translateZ(-30px) rotateY(90deg); border: 5px solid #0f172a; }
  #wheelR { width: 60px; height: 60px; left: 90px; top: 40px; border-radius: 50%; background: #1e293b; transform: translateZ(30px) rotateY(90deg); border: 5px solid #0f172a; }
  #casterL{ width: 16px; height: 16px; left: 15px; top: 110px; border-radius: 50%; background: #475569; transform: translateZ(-35px); }
  #casterR{ width: 16px; height: 16px; left: 109px; top: 110px; border-radius: 50%; background: #475569; transform: translateZ(35px); }

  .metrics-panel {
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px;
    width: 100%;
  }
  .metric-card {
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 12px;
    padding: 12px;
    text-align: center;
  }
  .metric-label { font-size: 11px; color: #94a3b8; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.05em; }
  .metric-value { font-size: 16px; font-weight: 700; color: #f1f5f9; font-family: monospace; }

  #status-banner {
    width: 100%;
    padding: 16px;
    border-radius: 12px;
    text-align: center;
    color: #fff;
    background: #059669;
    font-size: 15px; 
    font-weight: 700;
    letter-spacing: 0.02em;
    transition: all 0.3s ease;
  }
  #status-banner.alarm { background: #dc2626; box-shadow: 0 0 15px rgba(220, 38, 38, 0.4); }
  #status-banner.error { background: #475569; }
  #status-banner.calibrating { background: #ea580c; animation: pulse 0.5s infinite alternate; }
  
  .btn-group {
    display: grid;
    grid-template-columns: 1fr;
    gap: 12px;
  }

  .action-btn {
    padding: 14px;
    border: none;
    border-radius: 12px;
    background: #334155;
    color: #fff;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s ease;
    border: 1px solid #475569;
  }
  .action-btn:hover { background: #475569; }
  .action-btn:active { transform: scale(0.98); }
  .action-btn:disabled { background: #1e293b; color: #64748b; border-color: #334155; cursor: not-allowed; }
  .action-btn.primary { background: #2563eb; border-color: #3b82f6; }
  .action-btn.primary:hover { background: #1d4ed8; }

  @keyframes pulse { from { opacity: 1; } to { opacity: 0.6; } }
</style>
</head>
<body>
  <h1>MPU6500 6-Axis Diagnostic Lab</h1>
  <div class="subtitle">Filtered Real-time Stream over Hardware I2C (SDA=5, SCL=6)</div>

  <div class="container">
    <div class="card-3d">
      <div id="stage">
        <div id="world">
          <div id="floor"></div>
          <div id="chair">
            <div class="part" id="back"></div>
            <div class="part" id="seat"></div>
            <div class="part" id="wheelL"></div>
            <div class="part" id="wheelR"></div>
            <div class="part" id="casterL"></div>
            <div class="part" id="casterR"></div>
          </div>
        </div>
      </div>
    </div>

    <div class="metrics-panel">
      <div id="status-banner">CONNECTING TO WEBSOCKET...</div>

      <!-- Accelerometer -->
      <div class="grid">
        <div class="metric-card"><div class="metric-label">Accel X</div><div class="metric-value" id="ax">--</div></div>
        <div class="metric-card"><div class="metric-label">Accel Y</div><div class="metric-value" id="ay">--</div></div>
        <div class="metric-card"><div class="metric-label">Accel Z</div><div class="metric-value" id="az">--</div></div>
      </div>

      <!-- Gyroscope -->
      <div class="grid">
        <div class="metric-card"><div class="metric-label">Gyro X</div><div class="metric-value" id="gx">--</div></div>
        <div class="metric-card"><div class="metric-label">Gyro Y</div><div class="metric-value" id="gy">--</div></div>
        <div class="metric-card"><div class="metric-label">Gyro Z</div><div class="metric-value" id="gz">--</div></div>
      </div>

      <!-- Angles -->
      <div class="grid">
        <div class="metric-card"><div class="metric-label">Pitch</div><div class="metric-value" id="pitch">--</div></div>
        <div class="metric-card"><div class="metric-label">Roll</div><div class="metric-value" id="roll">--</div></div>
        <div class="metric-card"><div class="metric-label">Yaw</div><div class="metric-value" id="yaw">--</div></div>
      </div>

      <div class="btn-group">
        <button class="action-btn primary" id="calGyroBtn" onclick="calibrateGyro()">Calibrate Gyro &amp; Accel</button>
      </div>
    </div>
  </div>

<script>
var target = { pitch: 0, roll: 0, yaw: 0 };
var current = { pitch: 0, roll: 0, yaw: 0 };
var socket;

function lerp(a, b, t) { return a + (b - a) * t; }

function connect() {
  socket = new WebSocket('ws://' + location.host + '/ws');

  socket.onopen = function() {
    document.getElementById('status-banner').textContent = 'CONNECTED';
  };

  socket.onclose = function() {
    var banner = document.getElementById('status-banner');
    banner.className = 'error';
    banner.textContent = 'CONNECTION LOST - RECONNECTING...';
    setTimeout(connect, 1000);
  };

  socket.onerror = function() { socket.close(); };

  socket.onmessage = function(evt) {
    var d = JSON.parse(evt.data);
    
    document.getElementById('ax').textContent = d.ax.toFixed(3) + ' g';
    document.getElementById('ay').textContent = d.ay.toFixed(3) + ' g';
    document.getElementById('az').textContent = d.az.toFixed(3) + ' g';
    document.getElementById('gx').textContent = d.gx.toFixed(2) + ' °/s';
    document.getElementById('gy').textContent = d.gy.toFixed(2) + ' °/s';
    document.getElementById('gz').textContent = d.gz.toFixed(2) + ' °/s';
    document.getElementById('pitch').textContent = d.pitch.toFixed(1) + '°';
    document.getElementById('roll').textContent  = d.roll.toFixed(1) + '°';
    document.getElementById('yaw').textContent   = d.yaw.toFixed(1) + '°';

    var btnGyro = document.getElementById('calGyroBtn');
    var banner = document.getElementById('status-banner');

    if (!d.ok) {
      banner.className = 'error';
      banner.textContent = 'SENSOR FAULT - CHECK MPU6500 I2C';
      btnGyro.disabled = true;
    } else if (d.calMode === 1) {
      banner.className = 'calibrating';
      banner.textContent = 'CALIBRATING GYRO & ACCEL - KEEP STILL...';
      btnGyro.disabled = true;
    } else if (d.alarm) {
      banner.className = 'alarm';
      banner.textContent = 'MPU6500 ACTIVE - TILT WARNING!';
      btnGyro.disabled = false;
    } else {
      banner.className = '';
      banner.textContent = 'MPU6500 ONLINE - STABLE';
      btnGyro.disabled = false;
    }

    target.pitch = d.pitch;
    target.roll  = d.roll;
    target.yaw   = d.yaw;
  };
}

function calibrateGyro() {
  fetch('/cal_gyro');
}

function animate() {
  current.pitch = lerp(current.pitch, target.pitch, 0.35);
  current.roll  = lerp(current.roll,  target.roll,  0.35);
  current.yaw   = lerp(current.yaw,   target.yaw,   0.35);

  var chair = document.getElementById('chair');
  chair.style.transform =
    'rotateY(' + current.yaw + 'deg) ' +
    'rotateX(' + current.pitch + 'deg) ' +
    'rotateZ(' + current.roll + 'deg)';

  requestAnimationFrame(animate);
}

connect();
requestAnimationFrame(animate);
</script>
</body>
</html>
)HTML";

// ---------------- WebSocket event handler ----------------
void onWsEvent(AsyncWebSocket* server, AsyncWebSocketClient* client,
               AwsEventType type, void* arg, uint8_t* data, size_t len) {
  if (type == WS_EVT_CONNECT) {
    Serial.printf("WebSocket client #%u connected\n", client->id());
  } else if (type == WS_EVT_DISCONNECT) {
    Serial.printf("WebSocket client #%u disconnected\n", client->id());
  }
}

// ---------------- Tasks ----------------
void calibrationTask(void* pvParameters) {
  if (g_calMode == CAL_ACCEL_GYRO) {
    Serial.println("[Lab] Calibrating Accel/Gyro. Hold board still and flat...");
    calSumGX = calSumGY = calSumGZ = 0;
    calSumPitch = calSumRoll = 0;
    calCount = 0;
    while (calCount < 100) {
      float ax, ay, az, gx, gy, gz;
      if (read6Axis(ax, ay, az, gx, gy, gz)) {
        float pitchAcc = atan2(ay, sqrt(ax * ax + az * az)) * 180.0 / PI;
        float rollAcc  = atan2(-ax, az) * 180.0 / PI;
        calSumGX += gx;
        calSumGY += gy;
        calSumGZ += gz;
        calSumPitch += pitchAcc;
        calSumRoll += rollAcc;
        calCount++;
      }
      delay(10);
    }
    gyroBiasX = calSumGX / 100.0f;
    gyroBiasY = calSumGY / 100.0f;
    gyroBiasZ = calSumGZ / 100.0f;
    pitchOffset = calSumPitch / 100.0f;
    rollOffset = calSumRoll / 100.0f;
    g_pitch = 0;
    g_roll = 0;
    g_yaw = 0;
    lastFusionMicros = micros();
    Serial.println("[Lab] Accel/Gyro calibration complete.");
  }
  g_calMode = CAL_NONE;
  vTaskDelete(NULL);
}

void scanI2C() {
  Serial.println("[I2C Scanner] Scanning bus...");
  int nDevices = 0;
  for (byte address = 1; address < 127; address++) {
    Wire.beginTransmission(address);
    byte error = Wire.endTransmission();
    if (error == 0) {
      Serial.printf("  Found I2C device at address 0x%02X\n", address);
      nDevices++;
    }
  }
  if (nDevices == 0) {
    Serial.println("  No I2C devices detected. Verify power, GND, SDA, SCL, and pull-up resistors.");
  }
}

// ---------------- Setup ----------------
void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n--- ESP32-S3 MPU6500 Diagnostics Lab ---");

  pinMode(BUZZER_PIN, OUTPUT);
  buzzerWrite(false);

  Wire.begin(SDA_PIN, SCL_PIN, 400000);
  scanI2C();

  // Initialize main MPU6500 chip
  if (init6Axis()) {
    g_mpuOk = true;
    strcpy(g_chipName, "MPU6500");
    Serial.println("MPU6500 initialized OK (6-Axis Mode).");
  } else {
    g_mpuOk = false;
    Serial.println("MPU6500 initialization FAILED. Check wiring.");
  }

  lastFusionMicros = micros();

  // SoftAP setup
  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, AP_PASSWORD);
  IPAddress apIP = WiFi.softAPIP();
  Serial.println("SoftAP started.");
  Serial.printf("SSID: %s | PWD: %s\n", AP_SSID, AP_PASSWORD);
  Serial.printf("Access Dashboard at: http://%s\n", apIP.toString().c_str());

  ws.onEvent(onWsEvent);
  server.addHandler(&ws);

  server.on("/", HTTP_GET, [](AsyncWebServerRequest* request) {
    request->send_P(200, "text/html", PAGE_HTML);
  });

  server.on("/cal_gyro", HTTP_GET, [](AsyncWebServerRequest* request) {
    if (g_calMode == CAL_NONE) {
      g_calMode = CAL_ACCEL_GYRO;
      xTaskCreatePinnedToCore(calibrationTask, "calTask", 4096, NULL, 1, NULL, 1);
      request->send(200, "text/plain", "calibrating");
    } else {
      request->send(400, "text/plain", "busy");
    }
  });

  server.onNotFound([](AsyncWebServerRequest* request) {
    request->send(404, "text/plain", "Not found");
  });

  server.begin();
  Serial.println("Dashboard WebServer running.");
}

// ---------------- Loop ----------------
void loop() {
  unsigned long now = millis();

  if (now - lastSensorRead >= SENSOR_INTERVAL_MS) {
    lastSensorRead = now;

    if (g_mpuOk && g_calMode == CAL_NONE) {
      if (read6Axis(g_ax, g_ay, g_az, g_gx, g_gy, g_gz)) {
        float pitchAcc = atan2(g_ay, sqrt(g_ax * g_ax + g_az * g_az)) * 180.0 / PI;
        float rollAcc  = atan2(-g_ax, g_az) * 180.0 / PI;

        float calGX = g_gx - gyroBiasX;
        float calGY = g_gy - gyroBiasY;
        float calGZ = g_gz - gyroBiasZ;
        float pitchAccCal = pitchAcc - pitchOffset;
        float rollAccCal  = rollAcc  - rollOffset;

        unsigned long nowMicros = micros();
        float dt = (lastFusionMicros == 0) ? 0.05 : (nowMicros - lastFusionMicros) / 1000000.0;
        lastFusionMicros = nowMicros;
        if (dt <= 0 || dt > 0.5) dt = 0.05;

        // Complementary filter for Pitch and Roll (smoothed and noise-free)
        g_pitch = 0.98f * (g_pitch + calGX * dt) + 0.02f * pitchAccCal;
        g_roll  = 0.98f * (g_roll  + calGY * dt) + 0.02f * rollAccCal;
        
        // Relative Yaw integration
        g_yaw  += calGZ * dt;
        if (g_yaw > 180.0) g_yaw -= 360.0;
        if (g_yaw < -180.0) g_yaw += 360.0;

        g_alarmActive = (fabs(g_pitch) > TILT_THRESHOLD_DEG) || (fabs(g_roll) > TILT_THRESHOLD_DEG);
      } else {
        g_mpuOk = false;
      }
    }
    
    broadcastTelemetry();
  }

  if (now - lastWsCleanup >= 2000) {
    lastWsCleanup = now;
    ws.cleanupClients();
  }

  updateBuzzer();
}
