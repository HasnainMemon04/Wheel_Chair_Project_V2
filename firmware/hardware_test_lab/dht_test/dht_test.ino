/*
  =====================================================================
  ESP32 + DHT22 Ambient Sensor — Web Dashboard
  =====================================================================
  Hosts its own WiFi hotspot (Access Point mode, same style as the
  lock system) and serves a plain, fast auto-updating page showing:

    - Temperature (°C)
    - Humidity (%)
    - Dew Point (°C)          -> Magnus-Tetens formula
    - Heat Index / "Feels like" (°C) -> Rothfusz regression (NOAA)
    - Comfort level           -> classified from dew point
    - Hydration / clothing tip -> classified from heat index

  The page polls a /data JSON endpoint every 2 seconds via fetch()
  and updates the numbers in place — no page reloads, stays fast.

  Wiring (unchanged from your original):
    DHT22 data pin -> GPIO 5
    DHT22 VCC      -> 3.3V
    DHT22 GND      -> GND
    (use a 10k pull-up resistor between data and VCC if your module
    doesn't already have one built in)

  WiFi:
    Creates its own hotspot, same as the lock project.
    Connect to it, then open http://192.168.4.1
  =====================================================================
*/

#include <Arduino.h>
#include <DHT.h>
#include <WiFi.h>
#include <WebServer.h>
#include <math.h>

#define DHT_PIN  5
#define DHT_TYPE DHT22

DHT dht(DHT_PIN, DHT_TYPE);
WebServer server(80);

// ---------------- WiFi Access Point credentials ----------------
const char* AP_SSID     = "ESP32-Climate";
const char* AP_PASSWORD = "climate123"; // min 8 chars, or "" for open network

// ---------------- Latest readings (shared with web handlers) ----------------
float g_temp = NAN;
float g_hum  = NAN;
float g_dewPoint = NAN;
float g_heatIndex = NAN;
String g_comfort = "--";
String g_advice  = "--";
bool  g_sensorOk = false;

const unsigned long READ_INTERVAL_MS = 2000;
unsigned long lastRead = 0;

// ---------------- Calculations ----------------

// Magnus-Tetens approximation, valid for typical ambient ranges.
float calcDewPoint(float tempC, float humPct) {
  const float a = 17.27;
  const float b = 237.7;
  float alpha = ((a * tempC) / (b + tempC)) + log(humPct / 100.0);
  return (b * alpha) / (a - alpha);
}

// NOAA Rothfusz regression. Formula is defined in Fahrenheit, so we
// convert in, compute, convert back out to Celsius.
float calcHeatIndexC(float tempC, float humPct) {
  float T = tempC * 9.0 / 5.0 + 32.0; // to Fahrenheit
  float R = humPct;

  // Simple formula first (Steadman), used as-is below ~80F where the
  // full regression isn't valid / not meaningfully different.
  float simpleHI = 0.5 * (T + 61.0 + ((T - 68.0) * 1.2) + (R * 0.094));

  float hiF;
  if ((simpleHI + T) / 2.0 < 80.0) {
    hiF = simpleHI;
  } else {
    // Full Rothfusz regression
    hiF = -42.379
          + 2.04901523 * T
          + 10.14333127 * R
          - 0.22475541 * T * R
          - 0.00683783 * T * T
          - 0.05481717 * R * R
          + 0.00122874 * T * T * R
          + 0.00085282 * T * R * R
          - 0.00000199 * T * T * R * R;

    // Low-humidity adjustment
    if (R < 13.0 && T >= 80.0 && T <= 112.0) {
      float adj = ((13.0 - R) / 4.0) * sqrt((17.0 - fabs(T - 95.0)) / 17.0);
      hiF -= adj;
    }
    // High-humidity adjustment
    if (R > 85.0 && T >= 80.0 && T <= 87.0) {
      float adj = ((R - 85.0) / 10.0) * ((87.0 - T) / 5.0);
      hiF += adj;
    }
  }

  return (hiF - 32.0) * 5.0 / 9.0; // back to Celsius
}

// Classic dew point comfort scale (meteorological standard).
String classifyComfort(float dewC) {
  if (dewC < 10.0)  return "Dry, very comfortable";
  if (dewC < 13.0)  return "Comfortable";
  if (dewC < 16.0)  return "Comfortable, slightly humid";
  if (dewC < 18.0)  return "Somewhat uncomfortable, sticky";
  if (dewC < 21.0)  return "Uncomfortable, humid";
  if (dewC < 24.0)  return "Very humid, quite uncomfortable";
  return "Oppressive, extremely humid";
}

// Hydration/clothing guidance from heat index (feels-like), adapted
// from NOAA heat index caution categories.
String classifyAdvice(float hiC) {
  if (hiC < 27.0)
    return "Normal conditions. No special precautions needed.";
  if (hiC < 32.0)
    return "Caution: stay hydrated; light, breathable clothing recommended.";
  if (hiC < 39.0)
    return "Extreme caution: drink water regularly; avoid heavy exertion; wear light-colored, loose clothing.";
  if (hiC < 51.0)
    return "Danger: limit outdoor activity; hydrate frequently; wear minimal, breathable clothing; seek shade/cooling.";
  return "Extreme danger: avoid exposure; hydrate constantly; seek air conditioning immediately.";
}

void takeReading() {
  float h = dht.readHumidity();
  float t = dht.readTemperature();

  if (isnan(h) || isnan(t)) {
    g_sensorOk = false;
    Serial.println("Error: Failed to read from DHT22 sensor! Check wiring on pin 5.");
    return;
  }

  g_sensorOk = true;
  g_temp = t;
  g_hum  = h;
  g_dewPoint  = calcDewPoint(t, h);
  g_heatIndex = calcHeatIndexC(t, h);
  g_comfort   = classifyComfort(g_dewPoint);
  g_advice    = classifyAdvice(g_heatIndex);

  Serial.printf("Temp: %.1f C | Hum: %.1f %% | Dew Point: %.1f C | Heat Index: %.1f C | %s\n",
                g_temp, g_hum, g_dewPoint, g_heatIndex, g_comfort.c_str());
}

// ---------------- Web page ----------------
const char PAGE_HTML[] PROGMEM = R"HTML(
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Climate Dashboard</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px;
    background: #ffffff;
    font-family: Arial, Helvetica, sans-serif;
    color: #222222;
  }
  h1 {
    font-size: 5vw; margin: 0 0 20px 0; text-align: center;
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
    max-width: 640px;
    margin: 0 auto;
  }
  .card {
    border: 2px solid #eeeeee;
    border-radius: 10px;
    padding: 16px;
    text-align: center;
  }
  .label { font-size: 3.2vw; color: #666666; margin-bottom: 6px; }
  .value { font-size: 6vw; font-weight: bold; }
  .wide { grid-column: 1 / span 2; text-align: left; }
  .wide .label { font-size: 3.2vw; }
  .wide .value { font-size: 4vw; }
  #status { text-align: center; color: #c0392b; font-size: 3vw; margin-top: 10px; }
  @media (min-width: 700px) {
    h1 { font-size: 28px; }
    .label { font-size: 15px; }
    .value { font-size: 32px; }
    .wide .value { font-size: 20px; }
    #status { font-size: 14px; }
  }
</style>
</head>
<body>
  <h1>Ambient Climate Dashboard</h1>
  <div class="grid">
    <div class="card">
      <div class="label">Temperature</div>
      <div class="value" id="temp">-- °C</div>
    </div>
    <div class="card">
      <div class="label">Humidity</div>
      <div class="value" id="hum">-- %</div>
    </div>
    <div class="card">
      <div class="label">Dew Point</div>
      <div class="value" id="dew">-- °C</div>
    </div>
    <div class="card">
      <div class="label">Heat Index (Feels Like)</div>
      <div class="value" id="hi">-- °C</div>
    </div>
    <div class="card wide">
      <div class="label">Comfort Level</div>
      <div class="value" id="comfort">--</div>
    </div>
    <div class="card wide">
      <div class="label">Hydration / Clothing Tip</div>
      <div class="value" id="advice">--</div>
    </div>
  </div>
  <div id="status"></div>

<script>
function refresh() {
  fetch('/data').then(r => r.json()).then(d => {
    if (d.ok) {
      document.getElementById('temp').textContent = d.temp.toFixed(1) + " °C";
      document.getElementById('hum').textContent  = d.hum.toFixed(1) + " %";
      document.getElementById('dew').textContent  = d.dew.toFixed(1) + " °C";
      document.getElementById('hi').textContent   = d.hi.toFixed(1) + " °C";
      document.getElementById('comfort').textContent = d.comfort;
      document.getElementById('advice').textContent  = d.advice;
      document.getElementById('status').textContent = "";
    } else {
      document.getElementById('status').textContent = "Sensor read error - check wiring on pin 5.";
    }
  }).catch(() => {
    document.getElementById('status').textContent = "Connection lost, retrying...";
  });
}

refresh();
setInterval(refresh, 2000);
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
  json += "\"temp\":" + String(g_temp, 1) + ",";
  json += "\"hum\":" + String(g_hum, 1) + ",";
  json += "\"dew\":" + String(g_dewPoint, 1) + ",";
  json += "\"hi\":" + String(g_heatIndex, 1) + ",";
  json += "\"comfort\":\"" + g_comfort + "\",";
  json += "\"advice\":\"" + g_advice + "\"";
  json += "}";
  server.send(200, "application/json", json);
}

void handleNotFound() {
  server.send(404, "text/plain", "Not found");
}

// ---------------- Setup ----------------
void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("--- DHT22 Ambient Sensor Web Dashboard ---");

  dht.begin();
  Serial.println("DHT22 initialized. Testing communication...");

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

  takeReading(); // get an initial reading before first page load
  lastRead = millis();
}

// ---------------- Loop ----------------
void loop() {
  server.handleClient();

  unsigned long now = millis();
  if (now - lastRead >= READ_INTERVAL_MS) {
    lastRead = now;
    takeReading();
  }
}
