/*
  =====================================================================
  ESP32 Web-Controlled Lock System (Relay / Motor Power Cut-off)
  =====================================================================
  Hosts a tiny, plain, fast web page with ONE button:
    - Shows "LOCK  (Motor Power OFF)"  when currently UNLOCKED
    - Shows "UNLOCK (Motor Power ON)"  when currently LOCKED
  Tapping it toggles the relay instantly via AJAX (no page reload,
  so it feels fast on a phone).

  Relay wiring:
    Relay module IN  -> GPIO 26
    Relay module VCC -> 5V (or 3.3V if your module supports it)
    Relay module GND -> GND
    Motor power line routed through the relay's COM/NO (or COM/NC)
    contacts as appropriate for your setup.

  IMPORTANT — relay trigger type:
    Most cheap single-channel relay modules are ACTIVE-LOW
    (a LOW signal energizes the relay / closes the contact).
    This code assumes that. If your relay module is ACTIVE-HIGH
    instead, change RELAY_ACTIVE_LOW to false below — that's the
    only line you need to touch.

  WiFi:
    ESP32 creates its OWN WiFi hotspot (Access Point mode) — no router
    needed. Set the AP name/password below. Once powered on, connect
    your phone/PC to that WiFi network, then open the fixed IP address
    printed below (default AP IP is always 192.168.4.1).

  Safety default:
    On boot / reset / power loss recovery, the system starts LOCKED
    (motor power OFF) until someone explicitly unlocks it.
  =====================================================================
*/

#include <WiFi.h>
#include <WebServer.h>

// ---------------- WiFi Access Point credentials ----------------
const char* AP_SSID     = "ESP32-Lock";     // name shown in WiFi list
const char* AP_PASSWORD = "lock1234";       // min 8 chars, or use "" for open network

// ---------------- Relay configuration ----------------
#define RELAY_PIN         26
#define RELAY_ACTIVE_LOW  true   // set to false if your relay is active-HIGH

// ---------------- State ----------------
// true  = UNLOCKED (motor power ON)
// false = LOCKED   (motor power OFF)
bool isUnlocked = false;

WebServer server(80);

// ---------------- Relay helpers ----------------
void applyRelay() {
  bool energize = isUnlocked; // energize relay when unlocked (motor on)
  if (RELAY_ACTIVE_LOW) {
    digitalWrite(RELAY_PIN, energize ? LOW : HIGH);
  } else {
    digitalWrite(RELAY_PIN, energize ? HIGH : LOW);
  }
}

void setLocked() {
  isUnlocked = false;
  applyRelay();
  Serial.println("State -> LOCKED (motor power OFF)");
}

void setUnlocked() {
  isUnlocked = true;
  applyRelay();
  Serial.println("State -> UNLOCKED (motor power ON)");
}

// ---------------- Web page (plain, minimal, fast) ----------------
// Single button; JS fetch() call flips state without reloading the page.
const char PAGE_HTML[] PROGMEM = R"HTML(
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lock Control</title>
<style>
  * { box-sizing: border-box; }
  html, body {
    height: 100%; margin: 0;
    background: #ffffff;
    display: flex; align-items: center; justify-content: center;
    font-family: Arial, Helvetica, sans-serif;
  }
  #btn {
    width: 80vw; max-width: 360px;
    height: 80vw; max-height: 360px;
    border-radius: 50%;
    border: none;
    font-size: 6vw;
    font-weight: bold;
    cursor: pointer;
    color: #ffffff;
    background: #444444;
    transition: background 0.15s ease;
  }
  #btn.locked   { background: #c0392b; } /* red   = locked / power off */
  #btn.unlocked { background: #27ae60; } /* green = unlocked / power on */
  #btn:active { opacity: 0.85; }
</style>
</head>
<body>
  <button id="btn" onclick="toggle()">...</button>

<script>
function render(unlocked) {
  var btn = document.getElementById('btn');
  if (unlocked) {
    btn.textContent = "UNLOCK\n(Motor Power ON)";
    btn.className = "unlocked";
  } else {
    btn.textContent = "LOCK\n(Motor Power OFF)";
    btn.className = "locked";
  }
}

function refresh() {
  fetch('/state').then(r => r.text()).then(t => render(t.trim() === "1"));
}

function toggle() {
  fetch('/toggle').then(r => r.text()).then(t => render(t.trim() === "1"));
}

refresh();
</script>
</body>
</html>
)HTML";

// ---------------- HTTP handlers ----------------
void handleRoot() {
  server.send_P(200, "text/html", PAGE_HTML);
}

void handleState() {
  server.send(200, "text/plain", isUnlocked ? "1" : "0");
}

void handleToggle() {
  if (isUnlocked) {
    setLocked();
  } else {
    setUnlocked();
  }
  server.send(200, "text/plain", isUnlocked ? "1" : "0");
}

void handleNotFound() {
  server.send(404, "text/plain", "Not found");
}

// ---------------- Setup ----------------
void setup() {
  Serial.begin(115200);
  delay(300);

  pinMode(RELAY_PIN, OUTPUT);
  setLocked(); // safe default on boot: motor power OFF

  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, AP_PASSWORD);

  IPAddress apIP = WiFi.softAPIP();
  Serial.println("Access Point started.");
  Serial.print("WiFi name: ");
  Serial.println(AP_SSID);
  Serial.print("Connect, then open in your browser: http://");
  Serial.println(apIP);

  server.on("/", handleRoot);
  server.on("/state", handleState);
  server.on("/toggle", handleToggle);
  server.onNotFound(handleNotFound);

  server.begin();
  Serial.println("Web server started.");
}

// ---------------- Loop ----------------
void loop() {
  server.handleClient();
}
