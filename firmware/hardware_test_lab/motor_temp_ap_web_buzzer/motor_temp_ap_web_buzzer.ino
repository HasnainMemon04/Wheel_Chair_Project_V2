/*
  =====================================================================
  Motor Temperature Monitor — DS18B20 + Buzzer + Web Dashboard (AP)
  =====================================================================
  Behavior:
    - Reads the motor's DS18B20 sensor every cycle, prints to Serial.
    - Single threshold: MOTOR_CRIT_C.
        Temp < 80°C -> buzzer off,  page shows green "OK"
        Temp >= 80°C -> buzzer fast beep (150ms on/off), page shows
                        red "ALARM" and pulses
    - If the sensor is disconnected/unreadable, reported as ERROR on
      Serial and on the web page (buzzer stays off in this case).
    - ESP32 creates its own WiFi hotspot (same pattern as your lock
      and climate dashboards) — no router needed.
    - Web page auto-refreshes every 1 second via a small /data JSON
      call (no manual reload, stays fast).

  Wiring:
    Motor DS18B20 data -> GPIO 4   (with 4.7k pull-up to 3.3V)
    Motor DS18B20 VCC  -> 3.3V, GND -> GND
    Buzzer +  -> GPIO 13
    Buzzer -  -> GND

  WiFi:
    Connect to "ESP32-MotorTemp" (password below), then open
    http://192.168.4.1

  IMPORTANT — buzzer type:
    Assumes an active buzzer module driven HIGH = ON. If yours is
    active-LOW, flip BUZZER_ACTIVE_LOW below.

  Tuning:
    Adjust MOTOR_CRIT_C below to change the alarm trigger point.
  =====================================================================
*/

#include <Arduino.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <WiFi.h>
#include <WebServer.h>

// ---------------- Pin configuration ----------------
#define MOTOR_ONEWIRE_PIN    4
#define BUZZER_PIN           13
#define BUZZER_ACTIVE_LOW    false   // set true if your buzzer triggers on LOW

// ---------------- Temperature threshold (°C) ----------------
#define MOTOR_CRIT_C     60.0

// ---------------- Timing ----------------
#define READ_INTERVAL_MS   2000
#define BEEP_FAST_MS        150   // fast beep period while in alarm

// ---------------- WiFi Access Point credentials ----------------
const char* AP_SSID     = "ESP32-MotorTemp";
const char* AP_PASSWORD = "motor1234"; // min 8 chars, or "" for open network

// ---------------- OneWire bus / sensor ----------------
OneWire oneWireMotor(MOTOR_ONEWIRE_PIN);
DallasTemperature motorSensor(&oneWireMotor);
WebServer server(80);

// ---------------- Shared state ----------------
bool g_alarmActive = false;   // true when temp >= MOTOR_CRIT_C
bool g_sensorOk    = false;
float g_motorTemp  = NAN;

unsigned long lastRead = 0;
unsigned long lastBuzzerToggle = 0;
bool buzzerOn = false;

void buzzerWrite(bool on) {
  if (BUZZER_ACTIVE_LOW) {
    digitalWrite(BUZZER_PIN, on ? LOW : HIGH);
  } else {
    digitalWrite(BUZZER_PIN, on ? HIGH : LOW);
  }
}

// Non-blocking: called every loop() pass, fast-beeps whenever
// g_alarmActive is true, stays off otherwise.
void updateBuzzer() {
  unsigned long now = millis();

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

void takeReading() {
  motorSensor.requestTemperatures();
  float t = motorSensor.getTempCByIndex(0);
  g_sensorOk = (motorSensor.getDeviceCount() > 0) && (t != DEVICE_DISCONNECTED_C);

  if (g_sensorOk) {
    g_motorTemp = t;
    g_alarmActive = (g_motorTemp >= MOTOR_CRIT_C);
    Serial.printf("Motor: %.2f C [%s]\n", g_motorTemp, g_alarmActive ? "ALARM" : "OK");
  } else {
    g_alarmActive = false;
    Serial.printf("Motor: ERROR reading! Check wiring on pin %d.\n", MOTOR_ONEWIRE_PIN);
  }
}

// ---------------- Web page ----------------
const char PAGE_HTML[] PROGMEM = R"HTML(
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Motor Temp Monitor</title>
<style>
  * { box-sizing: border-box; }
  html, body {
    height: 100%; margin: 0;
    background: #ffffff;
    display: flex; align-items: center; justify-content: center;
    font-family: Arial, Helvetica, sans-serif;
  }
  #panel {
    width: 85vw; max-width: 400px;
    border-radius: 16px;
    padding: 30px 20px;
    text-align: center;
    color: #ffffff;
    background: #27ae60;
    transition: background 0.2s ease;
  }
  #panel.alarm { background: #c0392b; animation: pulse 0.6s infinite alternate; }
  #panel.error { background: #7f8c8d; }
  @keyframes pulse { from { opacity: 1; } to { opacity: 0.6; } }
  .label { font-size: 4vw; opacity: 0.9; margin-bottom: 8px; }
  .temp { font-size: 14vw; font-weight: bold; margin-bottom: 10px; }
  .status { font-size: 5vw; font-weight: bold; letter-spacing: 2px; }
  @media (min-width: 500px) {
    .label { font-size: 18px; }
    .temp { font-size: 64px; }
    .status { font-size: 22px; }
  }
</style>
</head>
<body>
  <div id="panel">
    <div class="label">Motor Temperature</div>
    <div class="temp" id="temp">-- °C</div>
    <div class="status" id="status">--</div>
  </div>

<script>
function refresh() {
  fetch('/data').then(r => r.json()).then(d => {
    var panel = document.getElementById('panel');
    var temp = document.getElementById('temp');
    var status = document.getElementById('status');

    if (!d.ok) {
      panel.className = "error";
      temp.textContent = "-- °C";
      status.textContent = "SENSOR ERROR";
      return;
    }

    temp.textContent = d.temp.toFixed(1) + " °C";
    if (d.alarm) {
      panel.className = "alarm";
      status.textContent = "ALARM - OVERHEAT";
    } else {
      panel.className = "";
      status.textContent = "OK";
    }
  }).catch(() => {
    document.getElementById('status').textContent = "CONNECTION LOST";
  });
}

refresh();
setInterval(refresh, 1000);
</script>
</body>
</html>
)HTML";

// ---------------- HTTP handlers ----------------
void handleRoot() {
  server.send_P(200, "text/html", PAGE_HTML);
}

void handleData() {
  String json = "{";
  json += "\"ok\":" + String(g_sensorOk ? "true" : "false") + ",";
  json += "\"temp\":" + String(g_motorTemp, 1) + ",";
  json += "\"alarm\":" + String(g_alarmActive ? "true" : "false");
  json += "}";
  server.send(200, "application/json", json);
}

void handleNotFound() {
  server.send(404, "text/plain", "Not found");
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("--- Motor Temperature Monitor (AP + Web + Buzzer) ---");

  pinMode(BUZZER_PIN, OUTPUT);
  buzzerWrite(false);

  motorSensor.begin();
  Serial.printf("Motor sensors found: %d (pin %d)\n", motorSensor.getDeviceCount(), MOTOR_ONEWIRE_PIN);

  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, AP_PASSWORD);
  IPAddress apIP = WiFi.softAPIP();
  Serial.println("Access Point started.");
  Serial.print("WiFi name: ");
  Serial.println(AP_SSID);
  Serial.print("Connect, then open in your browser: http://");
  Serial.println(apIP);

  server.on("/", handleRoot);
  server.on("/data", handleData);
  server.onNotFound(handleNotFound);
  server.begin();
  Serial.println("Web server started.");

  takeReading(); // initial reading before first page load
  lastRead = millis();
}

void loop() {
  server.handleClient();

  unsigned long now = millis();
  if (now - lastRead >= READ_INTERVAL_MS) {
    lastRead = now;
    takeReading();
  }

  updateBuzzer();
}
