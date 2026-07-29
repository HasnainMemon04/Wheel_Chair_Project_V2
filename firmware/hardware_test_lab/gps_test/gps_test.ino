/*
 * ESP32-S3  +  u-blox NEO-M8N  GNSS test lab
 * ------------------------------------------------------------
 * Fixes vs. the previous version:
 *  - All UBX checksums are now computed at RUNTIME (sendUBX). The old
 *    hard-coded arrays had wrong checksums on 6 of 7 messages, so the
 *    module silently NAK'd them. That is why nothing "took" outdoors.
 *  - waitForACK() confirms every config message before moving on.
 *  - Enables concurrent GPS + GLONASS + Galileo (+SBAS +QZSS).
 *    Galileo is OFF by default on M8 (datasheet 1.5.4) and needs CFG-GNSS.
 *  - NMEA raised to 4.10 so Galileo appears as $GAGSV.
 *  - Nav rate dropped to 1 Hz. The M8N max for GPS+GLONASS is 5 Hz
 *    (datasheet Table 1); 1 Hz is plenty for a wheelchair and eliminates
 *    the 9600-baud UART overflow that was corrupting sentences.
 *  - UART raised to 115200 for bandwidth headroom with GSV enabled.
 *  - Pedestrian dynamic model applied via a targeted mask (dynModel only).
 * ------------------------------------------------------------
 */

#include <Arduino.h>
#include <TinyGPS++.h>
#include <WiFi.h>
#include <WebServer.h>

// ---------- GPS CONFIG ----------
#define GPS_RX_PIN     18      // ESP32 RX  <- GPS TXD
#define GPS_TX_PIN     17      // ESP32 TX  -> GPS RXD
#define GPS_BAUD_BOOT  9600    // module default on cold boot
#define GPS_BAUD_FAST  115200  // target baud for this session
// If you see garbage at 115200 (long/noisy wires), change GPS_BAUD_FAST
// to 38400 here AND in the CFG-PRT payload's baud field below.

// ---------- WIFI AP CONFIG ----------
const char* AP_SSID = "ESP32-S3-GPS-Test";
const char* AP_PASS = "gpslab123";

HardwareSerial GPSSerial(1);
TinyGPSPlus gps;
WebServer server(80);

// Per-constellation "satellites in view" straight from the GSV talker IDs.
// This is how you confirm GLONASS / Galileo are actually being tracked.
TinyGPSCustom satsGPS(gps, "GPGSV", 3);  // GPS
TinyGPSCustom satsGLO(gps, "GLGSV", 3);  // GLONASS
TinyGPSCustom satsGAL(gps, "GAGSV", 3);  // Galileo
TinyGPSCustom satsGN (gps, "GNGSV", 3);  // combined (some FW)

// ---------- STATE ----------
#define RAW_LINES_MAX 14
String rawLines[RAW_LINES_MAX];
int rawLineCount = 0;
String currentRawLine = "";

unsigned long bootTime = 0;
unsigned long lastCharTime = 0;
bool everSawData = false;
int  maxSatellitesSeen = 0;

// ============================================================
//  UBX helpers  (checksum computed here -> never wrong again)
// ============================================================

// Frame + 8-bit Fletcher checksum over class,id,len,payload, then send.
void sendUBX(uint8_t cls, uint8_t id, const uint8_t* payload, uint16_t len) {
  uint8_t head[6] = { 0xB5, 0x62, cls, id, (uint8_t)(len & 0xFF), (uint8_t)(len >> 8) };
  uint8_t ckA = 0, ckB = 0;
  for (int i = 2; i < 6; i++) { ckA += head[i]; ckB += ckA; }   // class,id,len
  for (uint16_t i = 0; i < len; i++) { ckA += payload[i]; ckB += ckA; }
  GPSSerial.write(head, 6);
  if (len) GPSSerial.write(payload, len);
  uint8_t ck[2] = { ckA, ckB };
  GPSSerial.write(ck, 2);
  GPSSerial.flush();
}

// Wait for UBX-ACK-ACK (05 01) / NAK (05 00) matching cls/id.
// Reads through the NMEA stream looking for the 10-byte ACK frame.
bool waitForACK(uint8_t cls, uint8_t id, uint32_t timeoutMs = 1500) {
  uint32_t start = millis();
  uint8_t buf[10];
  int idx = 0;
  while (millis() - start < timeoutMs) {
    while (GPSSerial.available()) {
      uint8_t b = GPSSerial.read();
      // sliding-window match on B5 62 05 xx 02 00 cls id ckA ckB
      if (idx == 0 && b != 0xB5) continue;
      if (idx == 1 && b != 0x62) { idx = (b == 0xB5) ? 1 : 0; continue; }
      buf[idx++] = b;
      if (idx == 10) {
        idx = 0;
        if (buf[2] == 0x05 && buf[6] == cls && buf[7] == id) {
          bool ok = (buf[3] == 0x01);
          Serial.printf("[UBX %s] class 0x%02X id 0x%02X\n",
                        ok ? "ACK" : "NAK", cls, id);
          return ok;
        }
      }
    }
    delay(2);
  }
  Serial.printf("[UBX ----] no ACK for class 0x%02X id 0x%02X (timeout)\n", cls, id);
  return false;
}

void configureM8NGPS() {
  Serial.println("[GPS] Configuring NEO-M8N (GPS+GLONASS+Galileo, 1Hz, NMEA 4.10)...");

  // 1 Hz measurement rate (measRate=1000ms, navRate=1, timeRef=GPS)
  const uint8_t cfgRate[] = { 0xE8, 0x03, 0x01, 0x00, 0x01, 0x00 };
  sendUBX(0x06, 0x08, cfgRate, sizeof(cfgRate));
  waitForACK(0x06, 0x08);

  // Concurrent GNSS: GPS + SBAS + Galileo + QZSS + GLONASS (BeiDou/IMES off).
  // GPS+Galileo+GLONASS is a valid 3-system combo (datasheet Table 2).
  const uint8_t cfgGnss[] = {
    0x00, 0x00, 0xFF, 0x07,
    0x00, 0x08, 0x10, 0x00, 0x01, 0x00, 0x01, 0x00,   // GPS     L1C/A
    0x01, 0x01, 0x03, 0x00, 0x01, 0x00, 0x01, 0x00,   // SBAS    L1C/A
    0x02, 0x04, 0x08, 0x00, 0x01, 0x00, 0x01, 0x00,   // Galileo E1
    0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00,   // BeiDou  disabled
    0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,   // IMES    disabled
    0x05, 0x00, 0x03, 0x00, 0x01, 0x00, 0x01, 0x00,   // QZSS    L1C/A
    0x06, 0x08, 0x0E, 0x00, 0x01, 0x00, 0x01, 0x00    // GLONASS L1OF
  };
  sendUBX(0x06, 0x3E, cfgGnss, sizeof(cfgGnss));
  waitForACK(0x06, 0x3E);

  // NMEA version 4.10 (20-byte CFG-NMEA) so Galileo -> $GAGSV
  const uint8_t cfgNmea[] = {
    0x00, 0x41, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00
  };
  sendUBX(0x06, 0x17, cfgNmea, sizeof(cfgNmea));
  waitForACK(0x06, 0x17);

  // Pedestrian dynamic model (mask=0x0001 -> only dynModel touched)
  const uint8_t cfgNav5[] = {
    0x01, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00
  };
  sendUBX(0x06, 0x24, cfgNav5, sizeof(cfgNav5));
  waitForACK(0x06, 0x24);

  // Trim only the sentences we don't use (keep GGA/GSA/GSV/RMC).
  // GSV is KEPT on purpose: it is the only per-satellite / SNR / GLONASS
  // + Galileo visibility source. GGA drives sats-in-use for TinyGPS++.
  const uint8_t offGLL[] = { 0xF0, 0x01, 0, 0, 0, 0, 0, 0 };
  const uint8_t offVTG[] = { 0xF0, 0x05, 0, 0, 0, 0, 0, 0 };
  sendUBX(0x06, 0x01, offGLL, sizeof(offGLL)); waitForACK(0x06, 0x01);
  sendUBX(0x06, 0x01, offVTG, sizeof(offVTG)); waitForACK(0x06, 0x01);

  // Persist GNSS/NMEA/rate/model to BBR+Flash (baud NOT changed yet, so it
  // is not saved -> module cold-boots at 9600 and we re-negotiate cleanly).
  const uint8_t cfgSave[] = {
    0x00, 0x00, 0x00, 0x00, 0xFF, 0xFF, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x03
  };
  sendUBX(0x06, 0x09, cfgSave, sizeof(cfgSave));
  waitForACK(0x06, 0x09);

  // Constellation changes require a GNSS restart to take effect.
  // Controlled GNSS start (mode 0x09) with hot-start BBR mask preserves aiding.
  const uint8_t cfgRst[] = { 0x00, 0x00, 0x09, 0x00 };
  sendUBX(0x06, 0x04, cfgRst, sizeof(cfgRst));   // CFG-RST is not ACK'd
  delay(1200);

  // Finally raise the module UART to 115200 (this session only, not saved).
  const uint8_t cfgPrt[] = {
    0x01, 0x00, 0x00, 0x00, 0xD0, 0x08, 0x00, 0x00,
    0x00, 0xC2, 0x01, 0x00, 0x07, 0x00, 0x03, 0x00,
    0x00, 0x00, 0x00, 0x00
  };
  sendUBX(0x06, 0x00, cfgPrt, sizeof(cfgPrt));   // no ACK: baud changes immediately
  GPSSerial.flush();
  delay(100);
  GPSSerial.updateBaudRate(GPS_BAUD_FAST);
  Serial.printf("[GPS] Switched host UART to %d baud.\n", GPS_BAUD_FAST);
  Serial.println("[GPS] Configuration complete.");
}

// ============================================================
void addRawLine(String line) {
  for (int i = RAW_LINES_MAX - 1; i > 0; i--) rawLines[i] = rawLines[i - 1];
  rawLines[0] = line;
  if (rawLineCount < RAW_LINES_MAX) rawLineCount++;
}

String buildPage() {
  String html; html.reserve(5120);
  html += F("<!DOCTYPE html><html><head><meta charset='utf-8'>"
            "<meta name='viewport' content='width=device-width, initial-scale=1'>"
            "<meta http-equiv='refresh' content='2'>"
            "<title>NEO-M8N GNSS Lab</title><style>"
            "body{background:#0f172a;color:#f8fafc;font-family:'Segoe UI',sans-serif;font-size:14px;margin:0;padding:24px 16px;display:flex;flex-direction:column;align-items:center;}"
            "h1{font-size:24px;font-weight:700;margin-bottom:4px;background:linear-gradient(135deg,#38bdf8,#818cf8);-webkit-background-clip:text;-webkit-text-fill-color:transparent;}"
            "h2{font-size:16px;font-weight:600;margin:16px 0 8px;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;}"
            ".ok{color:#10b981;font-weight:bold;}.bad{color:#ef4444;font-weight:bold;}"
            ".raw{color:#cbd5e1;font-family:monospace;font-size:12px;padding:4px 0;border-bottom:1px solid #1e293b;word-break:break-all;}"
            ".box{background:#1e293b;border:1px solid #334155;padding:16px;border-radius:12px;margin-bottom:16px;width:100%;max-width:560px;}"
            ".grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;}"
            ".metric{background:#0f172a;border:1px solid #334155;border-radius:8px;padding:12px;text-align:center;}"
            ".metric-label{font-size:10px;color:#64748b;text-transform:uppercase;font-weight:700;letter-spacing:.05em;margin-bottom:4px;}"
            ".metric-val{font-size:16px;font-weight:700;font-family:monospace;}"
            ".sb{width:100%;max-width:560px;padding:12px;border-radius:8px;text-align:center;font-weight:700;margin-bottom:16px;}"
            ".locked{background:#059669;}.searching{background:#d97706;}.error{background:#475569;}"
            "</style></head><body>");

  html += F("<h1>NEO-M8N GNSS Test Lab</h1>");
  html += F("<div style='color:#64748b;font-size:13px;margin-bottom:20px;'>GPS + GLONASS + Galileo &middot; 1 Hz &middot; Pedestrian</div>");

  bool dataFlowing = everSawData && (millis() - lastCharTime < 3000);
  int sats = gps.satellites.isValid() ? gps.satellites.value() : 0;
  if (sats > maxSatellitesSeen) maxSatellitesSeen = sats;

  if (!dataFlowing)              html += F("<div class='sb error'>NO DATA — CHECK TX/RX WIRING & BAUD</div>");
  else if (gps.location.isValid()) html += "<div class='sb locked'>FIX OK (" + String(sats) + " SATS IN USE)</div>";
  else                           html += "<div class='sb searching'>SEARCHING (" + String(sats) + " IN USE)</div>";

  // Per-constellation visibility (proves GLONASS/Galileo are tracking)
  html += F("<div class='box'><h2>Constellations in View</h2><div class='grid'>");
  html += "<div class='metric'><div class='metric-label'>GPS</div><div class='metric-val'>"    + String(satsGPS.isUpdated()||satsGPS.value()[0] ? satsGPS.value() : "0") + "</div></div>";
  html += "<div class='metric'><div class='metric-label'>GLONASS</div><div class='metric-val'>"+ String(satsGLO.value()[0] ? satsGLO.value() : "0") + "</div></div>";
  html += "<div class='metric'><div class='metric-label'>Galileo</div><div class='metric-val' style='color:#a78bfa'>" + String(satsGAL.value()[0] ? satsGAL.value() : "0") + "</div></div>";
  html += "<div class='metric'><div class='metric-label'>Combined (GN)</div><div class='metric-val'>" + String(satsGN.value()[0] ? satsGN.value() : "-") + "</div></div>";
  html += F("</div></div>");

  html += F("<div class='box'><h2>Diagnostics</h2><div class='grid'>");
  html += "<div class='metric'><div class='metric-label'>Uptime</div><div class='metric-val'>" + String((millis()-bootTime)/1000) + "s</div></div>";
  html += "<div class='metric'><div class='metric-label'>UART Baud</div><div class='metric-val'>" + String(GPS_BAUD_FAST) + "</div></div>";
  html += "<div class='metric'><div class='metric-label'>Bytes Read</div><div class='metric-val'>" + String(gps.charsProcessed()) + "</div></div>";
  html += "<div class='metric'><div class='metric-label'>Failed CRC</div><div class='metric-val' style='color:" + String(gps.failedChecksum()>0?"#ef4444":"#10b981") + "'>" + String(gps.failedChecksum()) + "</div></div>";
  html += F("</div></div>");

  html += F("<div class='box'><h2>Navigation</h2><div class='grid'>");
  html += "<div class='metric'><div class='metric-label'>Sats in use</div><div class='metric-val'>" + String(sats) + "</div></div>";
  html += "<div class='metric'><div class='metric-label'>Max seen</div><div class='metric-val'>" + String(maxSatellitesSeen) + "</div></div>";
  html += "<div class='metric'><div class='metric-label'>HDOP</div><div class='metric-val'>" + String(gps.hdop.isValid()?gps.hdop.hdop():99.99,2) + "</div></div>";
  html += "<div class='metric'><div class='metric-label'>Altitude</div><div class='metric-val'>" + String(gps.altitude.isValid()?String(gps.altitude.meters(),1)+" m":"--") + "</div></div>";
  html += F("</div>");
  if (gps.location.isValid()) {
    html += "<div class='metric' style='margin-top:12px'><div class='metric-label'>Coordinates</div>";
    html += "<div class='metric-val' style='color:#38bdf8;font-size:18px'>" + String(gps.location.lat(),6) + ", " + String(gps.location.lng(),6) + "</div>";
    html += "<div style='font-size:10px;color:#475569;margin-top:4px'>Fix age: " + String(gps.location.age()) + " ms</div></div>";
  }
  html += F("</div>");

  html += F("<div class='box'><h2>Raw NMEA (latest)</h2>");
  if (rawLineCount == 0) html += F("<div class='bad'>Waiting for NMEA...</div>");
  else for (int i=0;i<rawLineCount;i++) html += "<div class='raw'>" + rawLines[i] + "</div>";
  html += F("</div></body></html>");
  return html;
}

void handleRoot() { server.send(200, "text/html", buildPage()); }

void setup() {
  Serial.begin(115200);
  delay(1500);
  Serial.println(F("\n=== ESP32-S3 NEO-M8N GNSS Lab ==="));

  GPSSerial.setRxBufferSize(2048);
  GPSSerial.begin(GPS_BAUD_BOOT, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
  delay(200);
  configureM8NGPS();

  bootTime = millis();
  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, AP_PASS);
  Serial.print(F("AP: ")); Serial.print(AP_SSID);
  Serial.print(F("  http://")); Serial.println(WiFi.softAPIP());

  server.on("/", handleRoot);
  server.begin();
}

void loop() {
  while (GPSSerial.available() > 0) {
    char c = GPSSerial.read();
    everSawData = true;
    lastCharTime = millis();
    gps.encode(c);
    if (c == '\n') {
      if (currentRawLine.length() > 0) addRawLine(currentRawLine);
      currentRawLine = "";
    } else if (c != '\r') {
      currentRawLine += c;
      if (currentRawLine.length() > 95) currentRawLine = "";
    }
  }
  server.handleClient();
}
