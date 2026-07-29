#include "wifi_portal.h"
#include "config.h"
#include <WiFi.h>
#include <WebServer.h>
#include <Preferences.h>

// ---------------------------------------------------------------------------
//  WiFi provisioning portal
//  AP SSID: "WheelchairSetup" (open, no password)
//  Config page: http://192.168.4.1
//  Credentials persisted in NVS namespace "wifi".
// ---------------------------------------------------------------------------

static const char* AP_SSID = "WheelchairSetup";
static const IPAddress AP_IP(192, 168, 4, 1);
static const IPAddress AP_NETMASK(255, 255, 255, 0);

static Preferences prefs;
static WebServer server(80);

static volatile bool portalActive = false;
static volatile bool gotNewCreds = false;
static String pendingSSID;
static String pendingPASS;

bool isPortalActive() {
    return portalActive;
}

bool loadSavedWiFiCreds(String &ssid, String &pass) {
    String s;
    String p;
    if (prefs.begin("wifi", false)) {
        if (prefs.isKey("ssid")) s = prefs.getString("ssid", "");
        if (prefs.isKey("pass")) p = prefs.getString("pass", "");
        prefs.end();
    }

    if (s.length() > 0) {
        ssid = s;
        pass = p;
        return true;                      // found saved creds
    }

    // Fall back to compile-time defaults from config.h / private_config.h
    ssid = WIFI_SSID;
    pass = WIFI_PASS;
    return false;
}

void saveWiFiCreds(const String &ssid, const String &pass) {
    if (!prefs.begin("wifi", false)) {
        Serial.println("[Portal] Failed to open WiFi credential storage.");
        return;
    }
    prefs.putString("ssid", ssid);
    prefs.putString("pass", pass);
    prefs.end();
    Serial.printf("[Portal] Saved WiFi creds to NVS. SSID: %s\n", ssid.c_str());
}

bool resetSavedWiFiCredsOnce(const char *resetToken) {
    if (!prefs.begin("wifi", false)) return false;
    const String appliedToken = prefs.isKey("reset_token")
        ? prefs.getString("reset_token", "")
        : "";
    const bool needsReset = appliedToken != resetToken;

    if (needsReset) {
        prefs.remove("ssid");
        prefs.remove("pass");
        prefs.putString("reset_token", resetToken);
    }

    prefs.end();

    if (needsReset) {
        Serial.println("[Portal] Cleared saved WiFi credentials; using configured default network.");
    }

    return needsReset;
}

// --- Minimal, self-contained config page (no external assets) ---
static const char PORTAL_HTML[] PROGMEM = R"HTML(
<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Wheelchair WiFi Setup</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
background:#0b0f14;color:#e8eef5;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:20px}
.card{width:100%;max-width:360px;background:#131a22;border:1px solid #223040;border-radius:16px;padding:24px}
h1{font-size:20px;margin:0 0 4px}
p{font-size:13px;color:#9fb0c0;margin:0 0 20px}
label{display:block;font-size:13px;margin:14px 0 6px;color:#c7d3df}
input{width:100%;padding:12px 14px;font-size:15px;border-radius:10px;border:1px solid #2a3b4d;
background:#0e141b;color:#e8eef5;outline:none}
input:focus{border-color:#3b82f6}
button{width:100%;margin-top:22px;padding:13px;font-size:15px;font-weight:600;border:0;border-radius:10px;
background:#3b82f6;color:#fff;cursor:pointer}
button:active{background:#2f6fd6}
.ok{margin-top:16px;font-size:13px;color:#34d399;text-align:center;min-height:18px}
</style></head><body>
<form class="card" method="POST" action="/save">
<h1>Wheelchair WiFi Setup</h1>
<p>Enter the WiFi network for this device to join.</p>
<label for="s">WiFi Name (SSID)</label>
<input id="s" name="ssid" autocomplete="off" required maxlength="63" placeholder="MyNetwork">
<label for="p">Password</label>
<input id="p" name="pass" type="password" autocomplete="off" maxlength="63" placeholder="(leave blank if open)">
<button type="submit">Save & Connect</button>
<div class="ok">Device will reboot into your network.</div>
</form></body></html>
)HTML";

static void handleRoot() {
    server.send_P(200, "text/html", PORTAL_HTML);
}

static void handleSave() {
    if (!server.hasArg("ssid")) {
        server.send(400, "text/plain", "Missing SSID");
        return;
    }
    pendingSSID = server.arg("ssid");
    pendingPASS = server.hasArg("pass") ? server.arg("pass") : "";
    pendingSSID.trim();

    if (pendingSSID.length() == 0) {
        server.send(400, "text/plain", "SSID cannot be empty");
        return;
    }

    // Persist immediately and flag the portal loop to close.
    saveWiFiCreds(pendingSSID, pendingPASS);
    gotNewCreds = true;

    String msg = "<!DOCTYPE html><meta charset='utf-8'>"
                 "<meta name='viewport' content='width=device-width,initial-scale=1'>"
                 "<body style='font-family:system-ui;background:#0b0f14;color:#e8eef5;"
                 "display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center'>"
                 "<div><h2>Saved.</h2><p>Connecting to <b>" + pendingSSID + "</b>.<br>"
                 "You can close this page.</p></div></body>";
    server.send(200, "text/html", msg);
}

static void handleNotFound() {
    // Redirect any request to the config page (helps phones pop the portal).
    server.sendHeader("Location", "http://192.168.4.1/", true);
    server.send(302, "text/plain", "");
}

bool startConfigPortal(uint32_t timeoutMs) {
    Serial.println("[Portal] Starting AP config portal 'WheelchairSetup' at http://192.168.4.1");

    gotNewCreds = false;
    portalActive = true;

    // Bring up a clean SoftAP (open network).
    WiFi.disconnect(true);
    WiFi.mode(WIFI_AP);
    WiFi.softAPConfig(AP_IP, AP_IP, AP_NETMASK);
    WiFi.softAP(AP_SSID);                 // open AP, no password
    delay(200);
    Serial.printf("[Portal] AP IP: %s  (join WiFi '%s', open http://192.168.4.1)\n",
                  WiFi.softAPIP().toString().c_str(), AP_SSID);

    server.on("/", HTTP_GET, handleRoot);
    server.on("/save", HTTP_POST, handleSave);
    server.onNotFound(handleNotFound);
    server.begin();

    uint32_t start = millis();
    while (!gotNewCreds) {
        server.handleClient();
        delay(5);                         // yield to other FreeRTOS tasks
        if (timeoutMs > 0 && (millis() - start) >= timeoutMs) {
            Serial.println("[Portal] Timed out with no submission.");
            break;
        }
    }

    if (gotNewCreds) {
        // Give the web server time to flush the HTTP response to the client browser
        delay(2000);
    }

    // Tear down the AP cleanly and hand WiFi back to STA mode.
    server.stop();
    WiFi.softAPdisconnect(true);
    WiFi.mode(WIFI_STA);
    delay(100);
    portalActive = false;

    if (gotNewCreds) {
        Serial.println("[Portal] Closed. New credentials captured.");
        return true;
    }
    return false;
}
