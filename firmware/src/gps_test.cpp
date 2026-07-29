#include <Arduino.h>
#include <TinyGPS++.h>
#include <WiFi.h>
#include <WebServer.h>

// ---------- GPS CONFIG ----------
#define GPS_RX_PIN 18   // Connects to GPS TXD
#define GPS_TX_PIN 17   // Connects to GPS RXD
#define GPS_BAUD   9600

// Target operational baud rate. If 115200 causes issues under long/noisy wiring,
// change GPS_BAUD_FAST to 38400 and update the CFG-PRT payload baudrate bytes
// at offset 8 (bytes 8-11: 0x00, 0xC2, 0x01, 0x00 -> 0x00, 0x96, 0x00, 0x00)
#define GPS_BAUD_FAST 115200

// GNSS reset mode: 0x09 is controlled GNSS start (hot start), 0x02 is GNSS-only software reset (fallback)
#define GPS_RESET_MODE 0x09

// ---------- WIFI AP CONFIG ----------
const char* AP_SSID = "ESP32-S3-GPS-Test";
const char* AP_PASS = "gpslab123";

HardwareSerial GPSSerial(1);
TinyGPSPlus gps;
WebServer server(80);

uint32_t activeGpsBaud = GPS_BAUD;

// ---------- DETAILED GNSS TELEMETRY ----------
int extractedFixQuality = 0;          // GGA: 0=No Fix, 1=GPS, 2=DGPS/SBAS, 4=RTK Fixed, 5=RTK Float
double extractedGeoidSeparation = 0.0; // GGA: height of geoid above WGS84
bool hasGeoidSeparation = false;

int extractedFixType = 1;             // GSA: 1=No Fix, 2=2D, 3=3D
double extractedPDOP = 99.99;         // GSA: Position Dilution
double extractedHDOP = 99.99;         // GSA: Horizontal Dilution
double extractedVDOP = 99.99;         // GSA: Vertical Dilution

char extractedRmcStatus = 'V';        // RMC: A=Valid, V=Void
char extractedRmcMode = 'N';          // RMC: Mode indicator (A, D, E, N)

// Satellites in use per constellation (confirmed and temp accumulation)
int satsInUseGPS = 0;
int satsInUseGLONASS = 0;
int satsInUseGalileo = 0;
int satsInUseBeiDou = 0;
int satsInUseSBAS = 0;
int satsInUseQZSS = 0;

int tempSatsInUseGPS = 0;
int tempSatsInUseGLONASS = 0;
int tempSatsInUseGalileo = 0;
int tempSatsInUseBeiDou = 0;
int tempSatsInUseSBAS = 0;
int tempSatsInUseQZSS = 0;

unsigned long lastGgaTime = 0;
unsigned long lastGsaTime = 0;
unsigned long lastRmcTime = 0;





// ---------- STATE ----------
#define RAW_LINES_MAX 24
String rawLines[RAW_LINES_MAX];
int rawLineCount = 0;
String currentRawLine = "";

unsigned long bootTime = 0;
unsigned long lastCharTime = 0;
bool everSawData = false;
int maxSatellitesSeen = 0;

bool isGgaValid() { return (everSawData && (millis() - lastGgaTime < 5000)); }
bool isGsaValid() { return (everSawData && (millis() - lastGsaTime < 5000)); }
bool isRmcValid() { return (everSawData && (millis() - lastRmcTime < 5000)); }

// ---------- SPEED & ALTITUDE FILTERING ----------
#define SPEED_BUF_SIZE 8
double speedBuf[SPEED_BUF_SIZE];
int speedBufIdx = 0;
int speedBufFilled = 0;

double filteredSpeed = 0.0;   // EMA-smoothed output (km/h)
double filteredAlt = 0.0;     // EMA-smoothed altitude (m)
bool altInitialized = false;
double rawSpeedLast = 0.0;    // Last raw reading for display

// Exponential Moving Average alpha (0.0-1.0)
// Lower = smoother but slower response, Higher = more responsive but noisier
const double EMA_ALPHA_SPEED = 0.3;
const double EMA_ALPHA_ALT   = 0.2;

// HDOP-adaptive stationary dead-zone
// When GPS precision is poor, position jitter causes false speed
// Scale the zero-speed threshold based on HDOP
double getStationaryThreshold(double hdop) {
  // Base threshold: 0.8 km/h (walking speed ~3-5 km/h)
  // At HDOP 1.0 (excellent): threshold = 0.8 km/h
  // At HDOP 2.0 (good):      threshold = 1.6 km/h
  // At HDOP 5.0 (moderate):  threshold = 4.0 km/h
  // Cap at 6.0 km/h to avoid masking real wheelchair movement
  double threshold = 0.8 * hdop;
  if (threshold > 6.0) threshold = 6.0;
  if (threshold < 0.5) threshold = 0.5;
  return threshold;
}

// Moving average of speed buffer
double speedMovingAvg() {
  if (speedBufFilled == 0) return 0.0;
  int count = min(speedBufFilled, SPEED_BUF_SIZE);
  double sum = 0.0;
  for (int i = 0; i < count; i++) sum += speedBuf[i];
  return sum / count;
}

// Process a new raw speed sample through the full filter chain
void processSpeedSample(double rawKmph, double hdop) {
  rawSpeedLast = rawKmph;
  
  // Stage 1: Push into circular buffer for moving average
  speedBuf[speedBufIdx] = rawKmph;
  speedBufIdx = (speedBufIdx + 1) % SPEED_BUF_SIZE;
  if (speedBufFilled < SPEED_BUF_SIZE) speedBufFilled++;
  
  // Stage 2: Moving average to reduce burst noise
  double avgSpeed = speedMovingAvg();
  
  // Stage 3: HDOP-adaptive stationary dead-zone
  double threshold = getStationaryThreshold(hdop);
  if (avgSpeed < threshold) avgSpeed = 0.0;
  
  // Stage 4: Exponential Moving Average for smooth output
  filteredSpeed = EMA_ALPHA_SPEED * avgSpeed + (1.0 - EMA_ALPHA_SPEED) * filteredSpeed;
  
  // Clamp very small residuals to zero for clean display
  if (filteredSpeed < 0.1) filteredSpeed = 0.0;
}

void processAltitudeSample(double altMeters) {
  if (!altInitialized) {
    filteredAlt = altMeters;
    altInitialized = true;
  } else {
    filteredAlt = EMA_ALPHA_ALT * altMeters + (1.0 - EMA_ALPHA_ALT) * filteredAlt;
  }
}

// ---------- SAT STATS IN VIEW ----------
int satsInViewGPS = 0;
int satsInViewGLONASS = 0;
int satsInViewGalileo = 0;
int satsInViewBeiDou = 0;

// ---------- PER-SATELLITE SNR TRACKING ----------
#define MAX_TRACKED_SATS 32

struct SatInfo {
  int prn;            // Satellite PRN / ID number
  int elev;           // Elevation in degrees (0-90, -1 if invalid)
  int azim;           // Azimuth in degrees (0-359, -1 if invalid)
  int snr;            // Signal-to-Noise Ratio in dB-Hz (0 = not tracked)
  char constellation; // 'G'=GPS, 'R'=GLONASS, 'E'=Galileo, 'B'=BeiDou
  unsigned long lastSeen; // millis() timestamp of last update
};

SatInfo trackedSats[MAX_TRACKED_SATS];
int trackedSatCount = 0;

// Helper: get signal quality label
const char* snrLabel(int snr) {
  if (snr == 0) return "No Signal";
  if (snr < 15) return "Very Weak";
  if (snr < 20) return "Weak";
  if (snr < 30) return "Moderate";
  if (snr < 40) return "Solid";
  return "Strong";
}

// Helper: get signal bar color (CSS)
const char* snrColor(int snr) {
  if (snr == 0) return "#475569";
  if (snr < 15) return "#ef4444";
  if (snr < 20) return "#f97316";
  if (snr < 30) return "#eab308";
  if (snr < 40) return "#22c55e";
  return "#10b981";
}

// ---------- GPS SATELLITE DATABASE (PRN 1-32) ----------
// Current active constellation as of 2026
struct GpsSatData {
  const char* name;   // Nickname or USA designation
  const char* block;  // Block generation
  int svn;            // Space Vehicle Number
};

const GpsSatData gpsSatDB[32] PROGMEM = {
  /* PRN 01 */ {"Sally Ride",        "III",  80},
  /* PRN 02 */ {"USA-180",           "IIR",  61},
  /* PRN 03 */ {"USA-258",           "IIF",  69},
  /* PRN 04 */ {"Vespucci",          "III",  74},
  /* PRN 05 */ {"USA-206",           "IIRM", 50},
  /* PRN 06 */ {"USA-251",           "IIF",  67},
  /* PRN 07 */ {"USA-201",           "IIRM", 48},
  /* PRN 08 */ {"USA-262",           "IIF",  72},
  /* PRN 09 */ {"USA-256",           "IIF",  68},
  /* PRN 10 */ {"USA-265",           "IIF",  73},
  /* PRN 11 */ {"Neil Armstrong",    "III",  78},
  /* PRN 12 */ {"USA-192",           "IIRM", 58},
  /* PRN 13 */ {"Hedy Lamarr",       "III",  83},
  /* PRN 14 */ {"Sacagawea",         "III",  77},
  /* PRN 15 */ {"USA-196",           "IIRM", 55},
  /* PRN 16 */ {"USA-166",           "IIR",  56},
  /* PRN 17 */ {"USA-183",           "IIRM", 53},
  /* PRN 18 */ {"Magellan",          "III",  75},
  /* PRN 19 */ {"USA-177",           "IIR",  59},
  /* PRN 20 */ {"Ellison Onizuka",   "III",  82},
  /* PRN 21 */ {"Katherine Johnson", "III",  81},
  /* PRN 22 */ {"USA-151",           "IIR",  44},
  /* PRN 23 */ {"Matthew Henson",    "III",  76},
  /* PRN 24 */ {"USA-239",           "IIF",  65},
  /* PRN 25 */ {"USA-213",           "IIF",  62},
  /* PRN 26 */ {"USA-260",           "IIF",  71},
  /* PRN 27 */ {"USA-242",           "IIF",  66},
  /* PRN 28 */ {"Amelia Earhart",    "III",  79},
  /* PRN 29 */ {"USA-199",           "IIRM", 57},
  /* PRN 30 */ {"USA-248",           "IIF",  64},
  /* PRN 31 */ {"USA-190",           "IIRM", 52},
  /* PRN 32 */ {"USA-266",           "IIF",  70},
};

// ---------- GLONASS SATELLITE DATABASE (PRN 65-88 / Slots 1-24) ----------
struct GloSatData {
  const char* name;   // Kosmos designation
  const char* block;  // Block generation
  int svn;            // Space Vehicle Number (GC System Number)
};

const GloSatData gloSatDB[24] PROGMEM = {
  /* Slot 01 / PRN 65 */ {"Kosmos 2456", "GLONASS-M",  730},
  /* Slot 02 / PRN 66 */ {"Kosmos 2485", "GLONASS-M",  747},
  /* Slot 03 / PRN 67 */ {"Kosmos 2476", "GLONASS-M",  744},
  /* Slot 04 / PRN 68 */ {"Kosmos 2544", "GLONASS-M",  759},
  /* Slot 05 / PRN 69 */ {"Kosmos 2527", "GLONASS-M",  756},
  /* Slot 06 / PRN 70 */ {"Kosmos 2584", "GLONASS-K2", 704},
  /* Slot 07 / PRN 71 */ {"Kosmos 2477", "GLONASS-M",  745},
  /* Slot 08 / PRN 72 */ {"Kosmos 2475", "GLONASS-M",  743},
  /* Slot 09 / PRN 73 */ {"Kosmos 2501", "GLONASS-K1", 702},
  /* Slot 10 / PRN 74 */ {"Kosmos 2436", "GLONASS-M",  723},
  /* Slot 11 / PRN 75 */ {"Kosmos 2547", "GLONASS-K1", 705},
  /* Slot 12 / PRN 76 */ {"Kosmos 2534", "GLONASS-M",  758},
  /* Slot 13 / PRN 77 */ {"Kosmos 2434", "GLONASS-M",  721},
  /* Slot 14 / PRN 78 */ {"Kosmos 2522", "GLONASS-M",  752},
  /* Slot 15 / PRN 79 */ {"Kosmos 2529", "GLONASS-M",  757},
  /* Slot 16 / PRN 80 */ {"Kosmos 2564", "GLONASS-M",  761},
  /* Slot 17 / PRN 81 */ {"Kosmos 2514", "GLONASS-M",  751},
  /* Slot 18 / PRN 82 */ {"Kosmos 2494", "GLONASS-M",  754},
  /* Slot 19 / PRN 83 */ {"Kosmos 2559", "GLONASS-K1", 707},
  /* Slot 20 / PRN 84 */ {"Kosmos 2595", "GLONASS-K1", 708},
  /* Slot 21 / PRN 85 */ {"Kosmos 2500", "GLONASS-M",  755},
  /* Slot 22 / PRN 86 */ {"Kosmos 2557", "GLONASS-K1", 706},
  /* Slot 23 / PRN 87 */ {"GLONASS R23", "GLONASS-M",  0},
  /* Slot 24 / PRN 88 */ {"Kosmos 2545", "GLONASS-M",  760},
};

// Get satellite display name and block for any constellation
String getSatDisplayName(int prn, char constellation) {
  if (constellation == 'G' && prn >= 1 && prn <= 32) {
    const GpsSatData* sat = &gpsSatDB[prn - 1];
    return String(sat->name);
  }
  if (constellation == 'R') {
    int slot = prn - 64; // NMEA GLONASS: PRN = slot + 64
    if (slot >= 1 && slot <= 24) {
      const GloSatData* sat = &gloSatDB[slot - 1];
      return String(sat->name);
    }
    return "GLONASS R" + String(slot);
  }
  if (constellation == 'E') return "Galileo E" + String(prn);
  if (constellation == 'B') return "BeiDou C" + String(prn);
  return "SAT-" + String(prn);
}

String getSatBlockInfo(int prn, char constellation) {
  if (constellation == 'G' && prn >= 1 && prn <= 32) {
    const GpsSatData* sat = &gpsSatDB[prn - 1];
    return "Block " + String(sat->block) + " | SVN " + String(sat->svn);
  }
  if (constellation == 'R') {
    int slot = prn - 64;
    if (slot >= 1 && slot <= 24) {
      const GloSatData* sat = &gloSatDB[slot - 1];
      if (sat->svn > 0) {
        return String(sat->block) + " | GC " + String(sat->svn);
      }
      return String(sat->block);
    }
    return "GLONASS-M/K";
  }
  if (constellation == 'E') return "Galileo FOC";
  if (constellation == 'B') return "BeiDou-3";
  return "";
}

int splitNMEA(const String& line, String* fields, int maxFields) {
  int fieldCount = 0;
  int fromIdx = 0;
  
  int starIdx = line.indexOf('*');
  String dataLine = (starIdx == -1) ? line : line.substring(0, starIdx);
  
  while (fieldCount < maxFields) {
    int nextComma = dataLine.indexOf(',', fromIdx);
    if (nextComma == -1) {
      fields[fieldCount++] = dataLine.substring(fromIdx);
      break;
    }
    fields[fieldCount++] = dataLine.substring(fromIdx, nextComma);
    fromIdx = nextComma + 1;
  }
  return fieldCount;
}

// Update or add a satellite entry
void updateSatEntry(int prn, int elev, int azim, int snr, char constellation) {
  // Search for existing entry
  for (int i = 0; i < trackedSatCount; i++) {
    if (trackedSats[i].prn == prn && trackedSats[i].constellation == constellation) {
      trackedSats[i].elev = elev;
      trackedSats[i].azim = azim;
      trackedSats[i].snr = snr;
      trackedSats[i].lastSeen = millis();
      return;
    }
  }
  // Add new entry if space available
  if (trackedSatCount < MAX_TRACKED_SATS) {
    trackedSats[trackedSatCount].prn = prn;
    trackedSats[trackedSatCount].elev = elev;
    trackedSats[trackedSatCount].azim = azim;
    trackedSats[trackedSatCount].snr = snr;
    trackedSats[trackedSatCount].constellation = constellation;
    trackedSats[trackedSatCount].lastSeen = millis();
    trackedSatCount++;
  }
}

// Expire satellites not seen for 10 seconds
void expireOldSats() {
  unsigned long now = millis();
  int writeIdx = 0;
  for (int i = 0; i < trackedSatCount; i++) {
    if (now - trackedSats[i].lastSeen < 10000) {
      if (writeIdx != i) trackedSats[writeIdx] = trackedSats[i];
      writeIdx++;
    }
  }
  trackedSatCount = writeIdx;
}

void parseGSV(String sentence) {
  if (sentence.indexOf("GSV") == -1) return;
  
  char constellation = '?';
  if (sentence.startsWith("$GP")) constellation = 'G';
  else if (sentence.startsWith("$GL")) constellation = 'R';
  else if (sentence.startsWith("$GA")) constellation = 'E';
  else if (sentence.startsWith("$GB") || sentence.startsWith("$BD")) constellation = 'B';

  int starPos = sentence.indexOf('*');
  String cleaned = (starPos > 0) ? sentence.substring(0, starPos) : sentence;

  String fields[24];
  int fieldCount = 0;
  int startIdx = 0;
  for (int i = 0; i <= cleaned.length() && fieldCount < 24; i++) {
    if (i == cleaned.length() || cleaned[i] == ',') {
      fields[fieldCount++] = cleaned.substring(startIdx, i);
      startIdx = i + 1;
    }
  }

  if (fieldCount >= 4) {
    int satVal = fields[3].toInt();
    switch (constellation) {
      case 'G': satsInViewGPS     = satVal; break;
      case 'R': satsInViewGLONASS = satVal; break;
      case 'E': satsInViewGalileo = satVal; break;
      case 'B': satsInViewBeiDou  = satVal; break;
    }
  }

  for (int blockStart = 4; blockStart + 3 < fieldCount; blockStart += 4) {
    String prnStr = fields[blockStart];
    String elevStr = fields[blockStart + 1];
    String azimStr = fields[blockStart + 2];
    String snrStr = fields[blockStart + 3];

    if (prnStr.length() == 0) continue;

    int prn = prnStr.toInt();
    int elev = (elevStr.length() > 0) ? elevStr.toInt() : -1;
    int azim = (azimStr.length() > 0) ? azimStr.toInt() : -1;
    int snr = (snrStr.length() > 0) ? snrStr.toInt() : 0;

    if (prn > 0) {
      updateSatEntry(prn, elev, azim, snr, constellation);
    }
  }
}

void parseGSA(const String& line) {
  String fields[20];
  int count = splitNMEA(line, fields, 20);
  if (count < 18) return;
  
  lastGsaTime = millis();
  
  if (fields[2].length() > 0) {
    extractedFixType = fields[2].toInt();
  }
  
  if (fields[15].length() > 0) {
    extractedPDOP = fields[15].toDouble();
  }
  if (fields[16].length() > 0) {
    extractedHDOP = fields[16].toDouble();
  }
  if (fields[17].length() > 0) {
    extractedVDOP = fields[17].toDouble();
  }
  
  int systemId = 0;
  if (count >= 19 && fields[18].length() > 0) {
    systemId = fields[18].toInt();
  }
  
  String talker = fields[0].substring(1, 3);
  if (systemId == 0) {
    if (talker == "GP") systemId = 1;
    else if (talker == "GL") systemId = 2;
    else if (talker == "GA") systemId = 3;
    else if (talker == "GB" || talker == "BD") systemId = 4;
    else if (talker == "GQ") systemId = 5;
  }
  
  int inUseCount = 0;
  for (int i = 3; i <= 14; i++) {
    if (fields[i].length() > 0 && fields[i].toInt() > 0) {
      inUseCount++;
    }
  }
  
  if (systemId == 1) {
    tempSatsInUseGPS += inUseCount;
  } else if (systemId == 2) {
    tempSatsInUseGLONASS += inUseCount;
  } else if (systemId == 3) {
    tempSatsInUseGalileo += inUseCount;
  } else if (systemId == 4) {
    tempSatsInUseBeiDou += inUseCount;
  } else if (systemId == 5) {
    tempSatsInUseQZSS += inUseCount;
  } else {
    for (int i = 3; i <= 14; i++) {
      if (fields[i].length() > 0) {
        int prn = fields[i].toInt();
        if (prn >= 1 && prn <= 32) tempSatsInUseGPS++;
        else if (prn >= 65 && prn <= 96) tempSatsInUseGLONASS++;
        else if (prn >= 301 && prn <= 336) tempSatsInUseGalileo++;
        else if (prn >= 401 && prn <= 437) tempSatsInUseBeiDou++;
        else if (prn >= 193 && prn <= 197) tempSatsInUseQZSS++;
        else if ((prn >= 33 && prn <= 64) || (prn >= 120 && prn <= 158)) tempSatsInUseSBAS++;
      }
    }
  }
}

void parseGGA(const String& line) {
  String fields[20];
  int count = splitNMEA(line, fields, 20);
  if (count < 12) return;
  
  lastGgaTime = millis();
  
  tempSatsInUseGPS = 0;
  tempSatsInUseGLONASS = 0;
  tempSatsInUseGalileo = 0;
  tempSatsInUseBeiDou = 0;
  tempSatsInUseSBAS = 0;
  tempSatsInUseQZSS = 0;
  
  if (fields[6].length() > 0) {
    extractedFixQuality = fields[6].toInt();
  }
  
  if (fields[11].length() > 0) {
    extractedGeoidSeparation = fields[11].toDouble();
    hasGeoidSeparation = true;
  } else {
    hasGeoidSeparation = false;
  }
}

void parseRMC(const String& line) {
  String fields[15];
  int count = splitNMEA(line, fields, 15);
  if (count < 13) return;
  
  lastRmcTime = millis();
  
  if (fields[2].length() > 0) {
    extractedRmcStatus = fields[2].charAt(0);
  }
  
  if (fields[12].length() > 0) {
    extractedRmcMode = fields[12].charAt(0);
  }

  // Commit accumulated Sats In Use at the end of the NMEA epoch
  satsInUseGPS = tempSatsInUseGPS;
  satsInUseGLONASS = tempSatsInUseGLONASS;
  satsInUseGalileo = tempSatsInUseGalileo;
  satsInUseBeiDou = tempSatsInUseBeiDou;
  satsInUseSBAS = tempSatsInUseSBAS;
  satsInUseQZSS = tempSatsInUseQZSS;
}

String buildSkyPlot() {
  String svg = F("<svg width='200' height='200' viewBox='0 0 200 200' style='background:#0f172a;border-radius:50%;border:2px solid #334155;'>");
  
  svg += F("<circle cx='100' cy='100' r='90' fill='none' stroke='#334155' stroke-width='1.5'/>");
  svg += F("<circle cx='100' cy='100' r='60' fill='none' stroke='#1e293b' stroke-dasharray='3,3'/>");
  svg += F("<circle cx='100' cy='100' r='30' fill='none' stroke='#1e293b' stroke-dasharray='3,3'/>");
  
  svg += F("<line x1='100' y1='10' x2='100' y2='190' stroke='#1e293b' stroke-width='1'/>");
  svg += F("<line x1='10' y1='100' x2='190' y2='100' stroke='#1e293b' stroke-width='1'/>");
  
  svg += F("<text x='100' y='22' fill='#64748b' font-size='10' font-weight='bold' text-anchor='middle'>N</text>");
  svg += F("<text x='100' y='188' fill='#64748b' font-size='10' font-weight='bold' text-anchor='middle'>S</text>");
  svg += F("<text x='188' y='103' fill='#64748b' font-size='10' font-weight='bold' text-anchor='middle'>E</text>");
  svg += F("<text x='12' y='103' fill='#64748b' font-size='10' font-weight='bold' text-anchor='middle'>W</text>");

  for (int i = 0; i < trackedSatCount; i++) {
    if (trackedSats[i].elev >= 0 && trackedSats[i].azim >= 0) {
      double el = trackedSats[i].elev;
      double az = trackedSats[i].azim;
      double snr = trackedSats[i].snr;
      
      double r = 90.0 * (90.0 - el) / 90.0;
      double theta = (az - 90.0) * PI / 180.0;
      double x = 100.0 + r * cos(theta);
      double y = 100.0 + r * sin(theta);
      
      double dotSize = 4.0 + (snr / 15.0);
      if (dotSize > 8.0) dotSize = 8.0;
      double opacity = 0.3 + 0.7 * (snr / 50.0);
      if (opacity > 1.0) opacity = 1.0;
      if (snr == 0) opacity = 0.15;

      const char* color = "#cbd5e1";
      const char* namePrefix = "?";
      switch (trackedSats[i].constellation) {
        case 'G': color = "#38bdf8"; namePrefix = "G"; break;
        case 'R': color = "#f43f5e"; namePrefix = "R"; break;
        case 'E': color = "#a78bfa"; namePrefix = "E"; break;
        case 'B': color = "#f59e0b"; namePrefix = "B"; break;
      }
      
      svg += "<circle cx='" + String(x, 1) + "' cy='" + String(y, 1) + "' r='" + String(dotSize, 1) + 
             "' fill='" + String(color) + "' fill-opacity='" + String(opacity, 2) + 
             "' stroke='#0f172a' stroke-width='1'>";
      svg += "<title>PRN: " + String(namePrefix) + String(trackedSats[i].prn) + 
             " | El: " + String(trackedSats[i].elev) + "&deg; | Az: " + String(trackedSats[i].azim) + 
             "&deg; | SNR: " + String(trackedSats[i].snr) + " dB-Hz</title>";
      svg += "</circle>";
      
      svg += "<text x='" + String(x + dotSize + 2.0, 1) + "' y='" + String(y + 3.0, 1) + 
             "' fill='#94a3b8' font-size='8' font-family='monospace'>" + String(namePrefix) + String(trackedSats[i].prn) + "</text>";
    }
  }

  svg += F("</svg>");
  return svg;
}

void addRawLine(String line) {
  for (int i = RAW_LINES_MAX - 1; i > 0; i--) {
    rawLines[i] = rawLines[i - 1];
  }
  // Prepend current uptime in seconds to make live updates obvious even with static NMEA strings
  rawLines[0] = "[" + String(millis() / 1000.0, 1) + "s] " + line;
  if (rawLineCount < RAW_LINES_MAX) rawLineCount++;
}

void sendUBXCommand(uint8_t msgClass, uint8_t msgId, const uint8_t* payload, uint16_t len) {
  uint8_t header[6];
  header[0] = 0xB5;
  header[1] = 0x62;
  header[2] = msgClass;
  header[3] = msgId;
  header[4] = len & 0xFF;
  header[5] = (len >> 8) & 0xFF;

  uint8_t ck_a = 0;
  uint8_t ck_b = 0;

  // Checksum over class, id, length, and payload
  ck_a += msgClass; ck_b += ck_a;
  ck_a += msgId;    ck_b += ck_a;
  ck_a += header[4]; ck_b += ck_a;
  ck_a += header[5]; ck_b += ck_a;

  for (uint16_t i = 0; i < len; i++) {
    ck_a += payload[i];
    ck_b += ck_a;
  }

  GPSSerial.write(header, 6);
  if (len > 0) {
    GPSSerial.write(payload, len);
  }
  uint8_t checksum[2] = { ck_a, ck_b };
  GPSSerial.write(checksum, 2);
  GPSSerial.flush();
}

bool waitForACK(uint8_t refClass, uint8_t refId, uint32_t timeoutMs = 1200) {
  uint32_t startTime = millis();
  uint8_t buffer[10];
  int idx = 0;

  while (millis() - startTime < timeoutMs) {
    while (GPSSerial.available() > 0) {
      uint8_t c = GPSSerial.read();

      // Look for the preamble sync chars 0xB5 0x62
      if (idx == 0 && c == 0xB5) {
        buffer[idx++] = c;
      } else if (idx == 1 && c == 0x62) {
        buffer[idx++] = c;
      } else if (idx >= 2 && idx < 10) {
        buffer[idx++] = c;

        if (idx == 10) {
          // Check if it is an ACK/NAK message (Class 0x05)
          if (buffer[2] == 0x05) {
            uint8_t ackType = buffer[3]; // 0x01 = ACK, 0x00 = NAK
            uint8_t ackClass = buffer[6];
            uint8_t ackMsgId = buffer[7];

            if (ackClass == refClass && ackMsgId == refId) {
              if (ackType == 0x01) {
                Serial.printf("[UBX ACK] Confirmed command: Class 0x%02X, ID 0x%02X\n", refClass, refId);
                return true;
              } else {
                Serial.printf("[UBX NAK] Rejected command: Class 0x%02X, ID 0x%02X!\n", refClass, refId);
                return false;
              }
            }
          }
          idx = 0; // reset
        }
      } else {
        idx = 0; // reset invalid sync
      }
    }
    delay(5);
  }
  Serial.printf("[UBX TIMEOUT] No response for Class 0x%02X, ID 0x%02X\n", refClass, refId);
  return false;
}

bool waitForPacket(uint8_t refClass, uint8_t refId, uint32_t timeoutMs = 300) {
  uint32_t startTime = millis();
  uint8_t buffer[6];
  int idx = 0;

  while (millis() - startTime < timeoutMs) {
    while (GPSSerial.available() > 0) {
      uint8_t c = GPSSerial.read();
      if (idx == 0 && c == 0xB5) {
        buffer[idx++] = c;
      } else if (idx == 1 && c == 0x62) {
        buffer[idx++] = c;
      } else if (idx >= 2 && idx < 6) {
        buffer[idx++] = c;
        if (idx == 6) {
          if (buffer[2] == refClass && buffer[3] == refId) {
            return true;
          }
          idx = 0; // reset
        }
      } else {
        idx = 0;
      }
    }
    delay(2);
  }
  return false;
}

double getAverageCN0() {
  double sum = 0.0;
  int count = 0;
  for (int i = 0; i < trackedSatCount; i++) {
    if (trackedSats[i].snr > 0) {
      sum += trackedSats[i].snr;
      count++;
    }
  }
  if (count == 0) return 0.0;
  return sum / count;
}

const char* avgCN0Color(double val) {
  if (val == 0.0) return "#64748b";
  if (val < 25.0) return "#ef4444"; // red (very poor)
  if (val < 35.0) return "#f97316"; // orange (indoor/weak)
  return "#10b981"; // green (strong/outdoor)
}

void pollVersion() {
  Serial.println("[GPS] Polling UBX-MON-VER info...");
  sendUBXCommand(0x0A, 0x04, NULL, 0);

  uint32_t startTime = millis();
  uint8_t buffer[160];
  int idx = 0;

  while (millis() - startTime < 1000) {
    while (GPSSerial.available() > 0) {
      uint8_t c = GPSSerial.read();
      if (idx == 0 && c == 0xB5) {
        buffer[idx++] = c;
      } else if (idx == 1 && c == 0x62) {
        buffer[idx++] = c;
      } else if (idx >= 2 && idx < 160) {
        buffer[idx++] = c;
        if (idx >= 6) {
          uint16_t len = buffer[4] | (buffer[5] << 8);
          if (len > 150) len = 150;
          if (idx == 6 + len + 2) {
            if (buffer[2] == 0x0A && buffer[3] == 0x04) {
              Serial.println("=== UBX-MON-VER ===");
              char swVer[31];
              memcpy(swVer, &buffer[6], min((int)len, 30));
              swVer[min((int)len, 30)] = '\0';
              Serial.printf("  Software Version: %s\n", swVer);
              
              if (len > 30) {
                char hwVer[11];
                memcpy(hwVer, &buffer[36], min((int)len - 30, 10));
                hwVer[min((int)len - 30, 10)] = '\0';
                Serial.printf("  Hardware Version: %s\n", hwVer);
              }
              Serial.println("===================");
              return;
            }
            idx = 0;
          }
        }
      } else {
        idx = 0;
      }
    }
    delay(2);
  }
  Serial.println("[GPS] Poll UBX-MON-VER timeout");
}

void pollGNSSConfig() {
  Serial.println("[GPS] Polling UBX-CFG-GNSS configuration...");
  sendUBXCommand(0x06, 0x3E, NULL, 0);

  uint32_t startTime = millis();
  uint8_t buffer[128];
  int idx = 0;

  while (millis() - startTime < 1000) {
    while (GPSSerial.available() > 0) {
      uint8_t c = GPSSerial.read();
      if (idx == 0 && c == 0xB5) {
        buffer[idx++] = c;
      } else if (idx == 1 && c == 0x62) {
        buffer[idx++] = c;
      } else if (idx >= 2 && idx < 128) {
        buffer[idx++] = c;
        if (idx >= 6) {
          uint16_t len = buffer[4] | (buffer[5] << 8);
          if (len > 120) len = 120;
          if (idx == 6 + len + 2) {
            if (buffer[2] == 0x06 && buffer[3] == 0x3E) {
              Serial.println("=== UBX-CFG-GNSS Constellation Verification ===");
              uint8_t numConfigBlocks = buffer[9]; // offset 3
              Serial.printf("  Number of config blocks: %d\n", numConfigBlocks);
              for (int i = 0; i < numConfigBlocks; i++) {
                int blockOffset = 10 + i * 8; // payload starts at offset 6, block starts at payload offset 4
                if (blockOffset + 7 < 6 + len) {
                  uint8_t gnssId = buffer[blockOffset];
                  uint8_t resTrkCh = buffer[blockOffset + 1];
                  uint8_t maxTrkCh = buffer[blockOffset + 2];
                  uint32_t flags = buffer[blockOffset + 4] | 
                                   (buffer[blockOffset + 5] << 8) | 
                                   (buffer[blockOffset + 6] << 16) | 
                                   (buffer[blockOffset + 7] << 24);
                  const char* name = "UNKNOWN";
                  if (gnssId == 0) name = "GPS";
                  else if (gnssId == 1) name = "SBAS";
                  else if (gnssId == 2) name = "Galileo";
                  else if (gnssId == 3) name = "BeiDou";
                  else if (gnssId == 4) name = "IMES";
                  else if (gnssId == 5) name = "QZSS";
                  else if (gnssId == 6) name = "GLONASS";

                  Serial.printf("  Constellation %s (ID %d): %s | Channels: res=%d, max=%d | Flags: 0x%08X\n",
                    name, gnssId, (flags & 0x01) ? "ENABLED" : "DISABLED", resTrkCh, maxTrkCh, flags);
                }
              }
              Serial.println("==============================================");
              return;
            }
            idx = 0;
          }
        }
      } else {
        idx = 0;
      }
    }
    delay(2);
  }
  Serial.println("[GPS] Poll UBX-CFG-GNSS timeout");
}

void autoBaudSync() {
  Serial.println("[GPS] Synchronizing UART baud rate...");
  
  // Try sending a poll version command at 9600 first
  GPSSerial.begin(9600, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
  delay(100);
  while (GPSSerial.available()) GPSSerial.read();
  
  sendUBXCommand(0x0A, 0x04, NULL, 0); // Poll version
  if (waitForPacket(0x0A, 0x04, 300)) {
    Serial.println("[GPS] Module verified responsive at 9600 baud.");
    activeGpsBaud = 9600;
    return;
  }
  
  // If no response, try at 115200 baud
  Serial.println("[GPS] No response at 9600. Trying 115200 baud...");
  GPSSerial.begin(115200, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
  delay(100);
  while (GPSSerial.available()) GPSSerial.read();
  
  sendUBXCommand(0x0A, 0x04, NULL, 0);
  if (waitForPacket(0x0A, 0x04, 300)) {
    Serial.println("[GPS] Module verified responsive at 115200 baud. Reverting to 9600 for configuration...");
    
    // Send UBX-CFG-PRT command to set module back to 9600 baud for configuration
    uint8_t cfg_prt_9600[20] = {
      0x01, 0x00, 0x00, 0x00,             // Port ID = 1 (UART1)
      0xD0, 0x08, 0x00, 0x00,             // mode: 8-N-1 (0x000008D0)
      0x80, 0x25, 0x00, 0x00,             // baudRate: 9600 (0x00002580)
      0x07, 0x00,                         // inProtoMask: UBX + NMEA + RTCM
      0x03, 0x00,                         // outProtoMask: UBX + NMEA
      0x00, 0x00,                         // flags: 0
      0x00, 0x00                          // reserved
    };
    sendUBXCommand(0x06, 0x00, cfg_prt_9600, 20);
    delay(150);
    
    // Switch ESP32 back to 9600
    GPSSerial.begin(9600, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
    activeGpsBaud = 9600;
    delay(100);
  } else {
    // If neither responds, default to 9600 and proceed
    Serial.println("[GPS] Sync failed. Defaulting to 9600 baud.");
    GPSSerial.begin(9600, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
    activeGpsBaud = 9600;
  }
}

void disableNMEA(uint8_t nmeaMsgId) {
  uint8_t payload[8] = { 0xF0, nmeaMsgId, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 };
  sendUBXCommand(0x06, 0x01, payload, 8);
  waitForACK(0x06, 0x01);
}

void enableNMEA(uint8_t nmeaMsgId) {
  uint8_t payload[8] = { 0xF0, nmeaMsgId, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00 };
  sendUBXCommand(0x06, 0x01, payload, 8);
  waitForACK(0x06, 0x01);
}

void fillGNSSBlock(uint8_t* payload, int offset, uint8_t gnssId, uint8_t res, uint8_t max, uint32_t flags) {
  payload[offset] = gnssId;
  payload[offset + 1] = res;
  payload[offset + 2] = max;
  payload[offset + 3] = 0; // reserved
  payload[offset + 4] = flags & 0xFF;
  payload[offset + 5] = (flags >> 8) & 0xFF;
  payload[offset + 6] = (flags >> 16) & 0xFF;
  payload[offset + 7] = (flags >> 24) & 0xFF;
}

void configureM8NGPS() {
  Serial.println("[Sensors] Initiating NEO-M8N GNSS configuration sequence...");

  // 1. Synchronize UART communication baudrate to 9600
  autoBaudSync();

  // 2. Set measurement rate to 1Hz (1000ms)
  // UBX-CFG-RATE (Class 0x06, ID 0x08)
  uint8_t cfg_rate_1hz[6] = {
    0xE8, 0x03, // measRate: 1000ms (0x03E8)
    0x01, 0x00, // navRate: 1 cycle
    0x01, 0x00  // timeRef: GPS time (1)
  };
  sendUBXCommand(0x06, 0x08, cfg_rate_1hz, 6);
  waitForACK(0x06, 0x08);

  // 3. Configure NMEA Version to 4.10 (20-byte payload structure)
  // UBX-CFG-NMEA (Class 0x06, ID 0x17)
  uint8_t cfg_nmea_410[20] = {
    0x00,                               // filter: no filter
    0x41,                               // nmeaVersion: 0x41 (NMEA v4.10)
    0x00,                               // numSV: unlimited
    0x02,                               // flags: consider mode bit
    0x00, 0x00, 0x00, 0x00,             // gnssToFilter: report all
    0x00,                               // svNumbering: default
    0x00,                               // mainTalkerId: default (GP/GL/GA/GB)
    0x00,                               // gsvTalkerId: default
    0x01,                               // version: 0x01
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 // reserved
  };
  sendUBXCommand(0x06, 0x17, cfg_nmea_410, 20);
  waitForACK(0x06, 0x17);

  // 4. Enable GPS + GLONASS + Galileo concurrently
  // UBX-CFG-GNSS (Class 0x06, ID 0x3E)
  uint8_t cfg_gnss_3const[60];
  cfg_gnss_3const[0] = 0x00; // msgVer = 0
  cfg_gnss_3const[1] = 0x00; // numTrkChHw
  cfg_gnss_3const[2] = 0xFF; // numTrkChUse
  cfg_gnss_3const[3] = 0x07; // numConfigBlocks = 7

  fillGNSSBlock(cfg_gnss_3const, 4,  0, 8, 16, 0x00010001); // GPS: Enabled, L1C/A
  fillGNSSBlock(cfg_gnss_3const, 12, 1, 1, 3,  0x00010001); // SBAS: Enabled, L1C/A
  fillGNSSBlock(cfg_gnss_3const, 20, 2, 4, 8,  0x00010001); // Galileo: Enabled, E1
  fillGNSSBlock(cfg_gnss_3const, 28, 3, 0, 0,  0x00010000); // BeiDou: Disabled
  fillGNSSBlock(cfg_gnss_3const, 36, 4, 0, 0,  0x00010000); // IMES: Disabled
  fillGNSSBlock(cfg_gnss_3const, 44, 5, 0, 3,  0x00010005); // QZSS: Enabled, L1C/A + L1S
  fillGNSSBlock(cfg_gnss_3const, 52, 6, 8, 14, 0x00010001); // GLONASS: Enabled, L1OF

  sendUBXCommand(0x06, 0x3E, cfg_gnss_3const, 60);
  waitForACK(0x06, 0x3E);

  // 5. Configure dynamic model to Pedestrian using targeted mask
  // UBX-CFG-NAV5 (Class 0x06, ID 0x24)
  uint8_t cfg_nav5[36];
  memset(cfg_nav5, 0, sizeof(cfg_nav5));
  cfg_nav5[0] = 0x01; // mask bit 0 = dynamic platform model setting (0x0001)
  cfg_nav5[1] = 0x00;
  cfg_nav5[2] = 0x03; // dynModel = Pedestrian (3)
  sendUBXCommand(0x06, 0x24, cfg_nav5, 36);
  waitForACK(0x06, 0x24);

  // 6. Enable AssistNow Autonomous (AOP)
  // UBX-CFG-NAVX5 (Class 0x06, ID 0x23)
  uint8_t cfg_navx5[40];
  memset(cfg_navx5, 0, sizeof(cfg_navx5));
  cfg_navx5[0] = 0x00; // version
  cfg_navx5[1] = 0x00;
  cfg_navx5[2] = 0x00; // mask1 bit 14 = AOP settings (0x4000)
  cfg_navx5[3] = 0x40;
  cfg_navx5[27] = 0x01; // aopCfg useAOP = 1
  sendUBXCommand(0x06, 0x23, cfg_navx5, 40);
  waitForACK(0x06, 0x23);

  // 7. Enable SBAS Ranging & Corrections
  // UBX-CFG-SBAS (Class 0x06, ID 0x16)
  uint8_t cfg_sbas[8] = {
    0x01, // mode: enabled = 1, testmode = 0
    0x07, // usage: ranging = 1, diffCorr = 1, integrity = 1
    0x03, // maxSBAS: 3 channels
    0x00, // scanmode2: auto-scan
    0x00, 0x00, 0x00, 0x00 // scanmode1: auto-scan
  };
  sendUBXCommand(0x06, 0x16, cfg_sbas, 8);
  waitForACK(0x06, 0x16);

  // 8. Explicitly configure NMEA message rates to ensure consistent state
  enableNMEA(0x00);  // Enable NMEA-GGA
  disableNMEA(0x01); // Disable NMEA-GLL
  enableNMEA(0x02);  // Enable NMEA-GSA
  enableNMEA(0x03);  // Enable NMEA-GSV
  enableNMEA(0x04);  // Enable NMEA-RMC
  disableNMEA(0x05); // Disable NMEA-VTG
  disableNMEA(0x08); // Disable NMEA-ZDA

  // 9. Save configuration to Non-Volatile Memory (BBR + Flash, no EEPROM)
  // UBX-CFG-CFG (Class 0x06, ID 0x09)
  uint8_t cfg_save[13] = {
    0x00, 0x00, 0x00, 0x00,             // clearMask: clear nothing
    0xFE, 0xFF, 0x00, 0x00,             // saveMask: save all EXCEPT port configuration (0xFFFE)
    0x00, 0x00, 0x00, 0x00,             // loadMask: load nothing
    0x03                                // deviceMask: 0x03 = BBR + Flash (no EEPROM)
  };
  sendUBXCommand(0x06, 0x09, cfg_save, 13);
  waitForACK(0x06, 0x09);

  // 10. Controlled GNSS Restart (Hot Start)
  // UBX-CFG-RST (Class 0x06, ID 0x04)
  uint8_t cfg_rst[4] = {
    0x00, 0x00,                         // navBbrMask: Hot Start (preserve BBR)
    GPS_RESET_MODE,                     // resetMode
    0x00                                // reserved
  };
  Serial.println("[GPS] Sending CFG-RST: Restarting GNSS subsystem...");
  sendUBXCommand(0x06, 0x04, cfg_rst, 4); 
  delay(500); // Allow receiver time to restart

  // 11. Change baud rate of GPS module to GPS_BAUD_FAST (session-only, not saved to flash)
  // UBX-CFG-PRT (Class 0x06, ID 0x00) for Port 1 (UART) to GPS_BAUD_FAST
  uint8_t cfg_prt_fast[20] = {
    0x01, 0x00, 0x00, 0x00,             // Port ID = 1 (UART1)
    0xD0, 0x08, 0x00, 0x00,             // mode: 8-N-1 config (0x000008D0)
    0x00, 0x00, 0x00, 0x00,             // baudRate placeholder (filled below)
    0x07, 0x00,                         // inProtoMask: UBX + NMEA + RTCM
    0x03, 0x00,                         // outProtoMask: UBX + NMEA
    0x00, 0x00,                         // flags: 0
    0x00, 0x00                          // reserved
  };
  cfg_prt_fast[8] = GPS_BAUD_FAST & 0xFF;
  cfg_prt_fast[9] = (GPS_BAUD_FAST >> 8) & 0xFF;
  cfg_prt_fast[10] = (GPS_BAUD_FAST >> 16) & 0xFF;
  cfg_prt_fast[11] = (GPS_BAUD_FAST >> 24) & 0xFF;
  
  Serial.printf("[GPS] Changing port baud to %d...\n", GPS_BAUD_FAST);
  sendUBXCommand(0x06, 0x00, cfg_prt_fast, 20);
  delay(150); // Settle

  // Re-open ESP32-S3 Serial1 at GPS_BAUD_FAST
  GPSSerial.begin(GPS_BAUD_FAST, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
  activeGpsBaud = GPS_BAUD_FAST;
  Serial.printf("[GPS] ESP32 UART speed switched to %d.\n", GPS_BAUD_FAST);

  // 12. Verification & Boot-time polling
  pollVersion();
  pollGNSSConfig();
}

String buildPage() {
  String html;
  html.reserve(12288);

  html += F("<!DOCTYPE html><html><head><meta charset='utf-8'>");
  html += F("<meta name='viewport' content='width=device-width, initial-scale=1'>");
  html += F("<meta http-equiv='refresh' content='1'>"); // Refresh every 1s
  html += F("<title>ESP32-S3 NEO-M8N GNSS Lab</title>");
  html += F("<style>"
             "body{background:#0f172a;color:#f8fafc;font-family:'Segoe UI',-apple-system,BlinkMacSystemFont,sans-serif;"
             "font-size:14px;margin:0;padding:24px 16px;display:flex;flex-direction:column;align-items:center;min-height:100vh;}"
             "h1{font-size:24px;font-weight:700;margin-bottom:4px;text-align:center;background:linear-gradient(135deg,#38bdf8,#818cf8);-webkit-background-clip:text;-webkit-text-fill-color:transparent;}"
             "h2{font-size:16px;font-weight:600;margin:16px 0 8px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.05em;}"
             "hr{border:none;border-top:1px solid #334155;margin:16px 0;}"
             ".ok{color:#10b981;font-weight:bold;}"
             ".bad{color:#ef4444;font-weight:bold;}"
             ".warn{color:#eab308;font-weight:bold;}"
             ".stale{color:#64748b;font-style:italic;}"
             ".raw{color:#cbd5e1;font-family:monospace;font-size:11px;padding:4px 0;border-bottom:1px solid #1e293b;word-break:break-all;}"
             ".raw:last-child{border-bottom:none;}"
             ".box{background:#1e293b;border:1px solid #334155;padding:16px;border-radius:12px;"
             "margin-bottom:16px;width:100%;max-width:560px;box-shadow:0 4px 6px -1px rgba(0,0,0,0.1),0 2px 4px -2px rgba(0,0,0,0.1);box-sizing:border-box;}"
             ".grid{display:grid;grid-template-columns:repeat(2, 1fr);gap:12px;margin-bottom:12px;}"
             ".grid-3{display:grid;grid-template-columns:repeat(3, 1fr);gap:12px;margin-bottom:12px;}"
             ".metric{background:#0f172a;border:1px solid #334155;border-radius:8px;padding:12px;text-align:center;}"
             ".metric-label{font-size:10px;color:#64748b;text-transform:uppercase;font-weight:700;letter-spacing:0.05em;margin-bottom:4px;}"
             ".metric-val{font-size:16px;font-weight:700;font-family:monospace;}"
             ".status-banner{width:100%;max-width:560px;padding:12px;border-radius:8px;text-align:center;font-weight:700;margin-bottom:16px;box-sizing:border-box;}"
             ".status-banner.locked{background:#059669;color:#fff;}"
             ".status-banner.searching{background:#d97706;color:#fff;animation:pulse 1s infinite alternate;}"
             ".status-banner.error{background:#475569;color:#fff;}"
             "@keyframes pulse { from { opacity: 1; } to { opacity: 0.7; } }"
             ".sat-row{display:flex;align-items:center;padding:8px 0;border-bottom:1px solid #1e293b;}"
             ".sat-row:last-child{border-bottom:none;}"
             ".sat-id{min-width:30px;font-weight:700;font-family:monospace;font-size:13px;}"
             ".sat-name{font-size:11px;color:#cbd5e1;min-width:90px;max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}"
             ".sat-name span{font-size:9px;color:#64748b;display:block;}"
             ".sat-const{font-size:9px;font-weight:700;padding:2px 4px;border-radius:4px;margin-right:6px;text-transform:uppercase;}"
             ".sat-bar-bg{flex:1;height:10px;background:#0f172a;border-radius:5px;overflow:hidden;margin:0 6px;}"
             ".sat-bar{height:100%;border-radius:5px;transition:width 0.3s;}"
             ".sat-snr{min-width:30px;text-align:right;font-family:monospace;font-size:12px;font-weight:700;}"
             ".sat-angle{min-width:55px;text-align:right;font-family:monospace;font-size:11px;color:#94a3b8;}"
             ".sat-label{min-width:55px;text-align:right;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:0.03em;}"
             "table{width:100%;border-collapse:collapse;margin-top:6px;font-size:12px;}"
             "th,td{padding:6px 8px;text-align:left;border-bottom:1px solid #334155;}"
             "th{color:#94a3b8;text-transform:uppercase;font-size:10px;font-weight:700;}"
             "</style></head><body>");

  html += F("<h1>NEO-M8N GNSS Lab Dashboard</h1>");
  html += F("<div style='color:#64748b;font-size:13px;margin-bottom:20px;'>Ultra-precise multi-constellation telematics diagnostic server</div>");

  bool dataFlowing = everSawData && (millis() - lastCharTime < 2500);
  int sats = gps.satellites.isValid() ? gps.satellites.value() : 0;
  if (sats > maxSatellitesSeen) maxSatellitesSeen = sats;

  bool gpsLocked = gps.location.isValid() && (gps.location.age() < 5000);
  bool fixValid = isRmcValid() && (extractedRmcStatus == 'A');
  bool is3DFix = isGsaValid() && (extractedFixType == 3);

  if (!dataFlowing) {
    html += F("<div class='status-banner error'>NO DATA FLOWING — CHECK GPS TX/RX PINS</div>");
  } else if (gpsLocked && fixValid && is3DFix) {
    html += "<div class='status-banner locked'>3D COORDINATE FIX OK (" + String(sats) + " SATS IN USE)</div>";
  } else if (gpsLocked) {
    html += "<div class='status-banner locked' style='background:#047857;'>2D COORDINATE FIX ACTIVE (" + String(sats) + " SATS IN USE)</div>";
  } else {
    html += "<div class='status-banner searching'>SEARCHING SATELLITES (" + String(sats) + " SATS DETECTED)</div>";
  }

  // --- 1. FIX STATUS Box ---
  html += F("<div class='box'><h2>Fix Status</h2>");
  html += F("<div class='grid'>");
  
  String qStr = "--";
  String qColor = "#94a3b8";
  if (isGgaValid()) {
    switch (extractedFixQuality) {
      case 0: qStr = "No Fix"; qColor = "#ef4444"; break;
      case 1: qStr = "GPS (SPS)"; qColor = "#10b981"; break;
      case 2: qStr = "DGPS/SBAS"; qColor = "#10b981"; break;
      case 4: qStr = "RTK Fixed"; qColor = "#38bdf8"; break;
      case 5: qStr = "RTK Float"; qColor = "#eab308"; break;
    }
  } else {
    qStr = "Stale"; qColor = "#64748b";
  }
  html += "<div class='metric'><div class='metric-label'>Fix Quality (GGA)</div><div class='metric-val' style='color:" + qColor + ";'>" + qStr + "</div></div>";

  String tStr = "--";
  String tColor = "#94a3b8";
  if (isGsaValid()) {
    switch (extractedFixType) {
      case 1: tStr = "No Fix"; tColor = "#ef4444"; break;
      case 2: tStr = "2D Fix"; tColor = "#eab308"; break;
      case 3: tStr = "3D Fix"; tColor = "#10b981"; break;
    }
  } else {
    tStr = "Stale"; tColor = "#64748b";
  }
  html += "<div class='metric'><div class='metric-label'>Fix Type (GSA)</div><div class='metric-val' style='color:" + tColor + ";'>" + tStr + "</div></div>";

  String rmcStatStr = "--";
  String rmcStatColor = "#94a3b8";
  if (isRmcValid()) {
    if (extractedRmcStatus == 'A') {
      rmcStatStr = "Valid (A)"; rmcStatColor = "#10b981";
    } else {
      rmcStatStr = "Void (V)"; rmcStatColor = "#ef4444";
    }
  } else {
    rmcStatStr = "Stale"; rmcStatColor = "#64748b";
  }
  html += "<div class='metric'><div class='metric-label'>RMC Status</div><div class='metric-val' style='color:" + rmcStatColor + ";'>" + rmcStatStr + "</div></div>";

  String modeStr = "--";
  String modeColor = "#94a3b8";
  if (isRmcValid()) {
    switch (extractedRmcMode) {
      case 'A': modeStr = "Autonomous"; modeColor = "#10b981"; break;
      case 'D': modeStr = "Differential"; modeColor = "#10b981"; break;
      case 'E': modeStr = "Estimated"; modeColor = "#eab308"; break;
      case 'N': modeStr = "Not Valid"; modeColor = "#ef4444"; break;
    }
  } else {
    modeStr = "Stale"; modeColor = "#64748b";
  }
  html += "<div class='metric'><div class='metric-label'>Operating Mode</div><div class='metric-val' style='color:" + modeColor + ";'>" + modeStr + "</div></div>";

  html += F("</div></div>");

  // --- 2. PRECISION Box ---
  html += F("<div class='box'><h2>Precision Metrics</h2>");
  html += F("<div class='grid-3'>");
  
  String pdopStr = (isGsaValid() && extractedPDOP < 99.0) ? String(extractedPDOP, 2) : "--";
  String hdopStr = (isGsaValid() && extractedHDOP < 99.0) ? String(extractedHDOP, 2) : "--";
  String vdopStr = (isGsaValid() && extractedVDOP < 99.0) ? String(extractedVDOP, 2) : "--";

  html += "<div class='metric'><div class='metric-label'>PDOP</div><div class='metric-val'>" + pdopStr + "</div></div>";
  html += "<div class='metric'><div class='metric-label'>HDOP</div><div class='metric-val'>" + hdopStr + "</div></div>";
  html += "<div class='metric'><div class='metric-label'>VDOP</div><div class='metric-val'>" + vdopStr + "</div></div>";
  html += F("</div>");

  double avgCN0 = getAverageCN0();
  html += "<div class='metric' style='margin-top:4px;'><div class='metric-label'>Average C/N0 (Signal Strength)</div><div class='metric-val' style='color:" + String(avgCN0Color(avgCN0)) + "; font-size:18px;'>" + (avgCN0 > 0.0 ? String(avgCN0, 1) + " dB-Hz" : "--") + "</div></div>";
  html += F("</div>");

  // --- 3. POSITION Box ---
  html += F("<div class='box'><h2>Position</h2>");
  html += F("<div class='grid'>");
  
  String latStr = gpsLocked ? String(gps.location.lat(), 6) + "&deg;" : "--";
  String lngStr = gpsLocked ? String(gps.location.lng(), 6) + "&deg;" : "--";
  
  html += "<div class='metric'><div class='metric-label'>Latitude</div><div class='metric-val' style='color:#38bdf8;'>" + latStr + "</div></div>";
  html += "<div class='metric'><div class='metric-label'>Longitude</div><div class='metric-val' style='color:#38bdf8;'>" + lngStr + "</div></div>";

  String altStr = (everSawData && gps.altitude.isValid() && gps.altitude.age() < 5000) ? String(filteredAlt, 1) + " m" : "--";
  String geoidStr = (isGgaValid() && hasGeoidSeparation) ? String(extractedGeoidSeparation, 1) + " m" : "--";

  html += "<div class='metric'><div class='metric-label'>Altitude (MSL)</div><div class='metric-val'>" + altStr + "</div>";
  if (gps.altitude.isValid() && gps.altitude.age() < 5000) {
    html += "<div style='font-size:8px;color:#475469;margin-top:2px;'>raw: " + String(gps.altitude.meters(), 1) + " m</div>";
  }
  html += "</div>";
  
  html += "<div class='metric'><div class='metric-label'>Geoid Separation</div><div class='metric-val'>" + geoidStr + "</div></div>";

  html += F("</div>");
  String ageStr = gpsLocked ? String(gps.location.age()) + " ms" : "--";
  html += "<div class='metric'><div class='metric-label'>Fix Aiding / Age</div><div class='metric-val'>" + ageStr + "</div></div>";
  html += F("</div>");

  // --- 4. MOTION Box ---
  html += F("<div class='box'><h2>Motion</h2>");
  html += F("<div class='grid'>");

  bool speedAgeValid = everSawData && gps.speed.isValid() && (gps.speed.age() < 5000);
  String fSpeedStr = speedAgeValid ? String(filteredSpeed, 1) + " km/h" : "--";
  String rSpeedStr = speedAgeValid ? String(rawSpeedLast, 1) + " km/h" : "--";

  html += "<div class='metric'><div class='metric-label'>Filtered Speed</div><div class='metric-val' style='color:#10b981;'>" + fSpeedStr + "</div></div>";
  html += "<div class='metric'><div class='metric-label'>Raw Speed</div><div class='metric-val'>" + rSpeedStr + "</div></div>";
  
  String courseStr = (everSawData && gps.course.isValid() && gps.course.age() < 5000) ? String(gps.course.deg(), 1) + "&deg;" : "--";
  html += "<div class='metric' style='grid-column: span 2;'><div class='metric-label'>Ground Course/Heading</div><div class='metric-val'>" + courseStr + "</div></div>";
  html += F("</div></div>");

  // --- 5. TIME Box ---
  html += F("<div class='box'><h2>UTC Synchronized Time</h2>");
  String timeStr = "--";
  if (everSawData && gps.date.isValid() && gps.time.isValid() && gps.date.age() < 5000) {
    char buf[40];
    snprintf(buf, sizeof(buf), "%02d/%02d/%04d %02d:%02d:%02d UTC",
             gps.date.day(), gps.date.month(), gps.date.year(),
             gps.time.hour(), gps.time.minute(), gps.time.second());
    timeStr = String(buf);
  }
  html += "<div class='metric'><div class='metric-label'>GPS Atomic Clock</div><div class='metric-val' style='font-size:18px; color:#a78bfa;'>" + timeStr + "</div></div>";
  html += F("</div>");

  // --- 6. CONSTELLATIONS Box ---
  html += F("<div class='box'><h2>Constellation Tracking</h2>");
  html += F("<table><tr><th>System</th><th>Sats in View</th><th>Sats in Use</th></tr>");
  
  html += "<tr><td><b>GPS (USA)</b></td><td>" + String(satsInViewGPS) + "</td><td>" + (isGgaValid() ? String(satsInUseGPS) : "--") + "</td></tr>";
  html += "<tr><td><b>GLONASS (RU)</b></td><td>" + String(satsInViewGLONASS) + "</td><td>" + (isGgaValid() ? String(satsInUseGLONASS) : "--") + "</td></tr>";
  html += "<tr><td><b>Galileo (EU)</b></td><td>" + String(satsInViewGalileo) + "</td><td>" + (isGgaValid() ? String(satsInUseGalileo) : "--") + "</td></tr>";
  html += "<tr><td><b>BeiDou (CN)</b></td><td>" + String(satsInViewBeiDou) + "</td><td>" + (isGgaValid() ? String(satsInUseBeiDou) : "--") + "</td></tr>";
  html += "<tr><td><b>SBAS (Aiding)</b></td><td>--</td><td>" + (isGgaValid() ? String(satsInUseSBAS) : "--") + "</td></tr>";
  html += "<tr><td><b>QZSS (JP)</b></td><td>--</td><td>" + (isGgaValid() ? String(satsInUseQZSS) : "--") + "</td></tr>";
  
  html += F("</table></div>");

  // --- 7. SATELLITE SIGNAL MAP & SKY VIEW Box ---
  expireOldSats();
  html += F("<div class='box' style='max-width:560px;'><h2>Satellite Sky View &amp; Signal Map</h2>");
  
  html += F("<div style='display:flex;flex-wrap:wrap;justify-content:center;gap:16px;align-items:center;margin-bottom:12px;'>");
  
  html += buildSkyPlot();
  
  html += F("<div style='flex:1;min-width:160px;'>");
  html += "<div style='font-size:12px;color:#94a3b8;margin-bottom:6px;'>Active SVs: <b>" + String(trackedSatCount) + "</b></div>";
  html += "<div style='font-size:12px;color:#38bdf8;'>GPS (Blue): <b>" + String(satsInViewGPS) + "</b> view</div>";
  html += "<div style='font-size:12px;color:#f43f5e;'>GLONASS (Red): <b>" + String(satsInViewGLONASS) + "</b> view</div>";
  html += "<div style='font-size:12px;color:#a78bfa;'>Galileo (Purple): <b>" + String(satsInViewGalileo) + "</b> view</div>";
  html += "<div style='font-size:12px;color:#f59e0b;'>BeiDou (Amber): <b>" + String(satsInViewBeiDou) + "</b> view</div>";
  html += F("</div></div>");

  int withSignal = 0;
  int noSignal = 0;
  for (int i = 0; i < trackedSatCount; i++) {
    if (trackedSats[i].snr > 0) withSignal++;
    else noSignal++;
  }

  if (trackedSatCount == 0) {
    html += F("<div style='color:#64748b;text-align:center;padding:12px;'>No satellites detected yet...</div>");
  } else if (withSignal == 0) {
    html += F("<div style='color:#f97316;text-align:center;padding:12px;'>Satellites in view but no signal lock yet...</div>");
  } else {
    SatInfo sorted[MAX_TRACKED_SATS];
    int sortedCount = 0;
    for (int i = 0; i < trackedSatCount; i++) {
      if (trackedSats[i].snr > 0) sorted[sortedCount++] = trackedSats[i];
    }
    for (int i = 0; i < sortedCount - 1; i++) {
      for (int j = 0; j < sortedCount - i - 1; j++) {
        if (sorted[j].snr < sorted[j+1].snr) {
          SatInfo tmp = sorted[j]; sorted[j] = sorted[j+1]; sorted[j+1] = tmp;
        }
      }
    }

    html += "<div style='font-size:11px;color:#94a3b8;margin-bottom:8px;'>" + String(withSignal) + " satellites receiving signal</div>";

    for (int i = 0; i < sortedCount; i++) {
      const char* constName = "???";
      const char* constColor = "#64748b";
      switch (sorted[i].constellation) {
        case 'G': constName = "GPS";     constColor = "#3b82f6"; break;
        case 'R': constName = "GLO";     constColor = "#ef4444"; break;
        case 'E': constName = "GAL";     constColor = "#a855f7"; break;
        case 'B': constName = "BDS";     constColor = "#f59e0b"; break;
      }
      int barWidth = min(sorted[i].snr * 2, 100);
      const char* sigColor = snrColor(sorted[i].snr);
      const char* sigLabel = snrLabel(sorted[i].snr);

      String satName = getSatDisplayName(sorted[i].prn, sorted[i].constellation);
      String blockInfo = getSatBlockInfo(sorted[i].prn, sorted[i].constellation);

      html += "<div class='sat-row'>";
      html += "<div class='sat-id'>" + String(sorted[i].prn) + "</div>";
      html += "<div class='sat-const' style='background:" + String(constColor) + ";color:#fff;'>" + String(constName) + "</div>";
      html += "<div class='sat-name'>" + satName + "<span>" + blockInfo + "</span></div>";
      html += "<div class='sat-bar-bg'><div class='sat-bar' style='width:" + String(barWidth) + "%;background:" + String(sigColor) + ";'></div></div>";
      
      String angStr = "--";
      if (sorted[i].elev >= 0 && sorted[i].azim >= 0) {
        angStr = String(sorted[i].elev) + "&deg;/" + String(sorted[i].azim) + "&deg;";
      }
      html += "<div class='sat-angle'>" + angStr + "</div>";
      
      html += "<div class='sat-snr' style='color:" + String(sigColor) + ";'>" + String(sorted[i].snr) + " dB</div>";
      html += "<div class='sat-label' style='color:" + String(sigColor) + ";'>" + String(sigLabel) + "</div>";
      html += "</div>";
    }

    if (noSignal > 0) {
      html += "<div style='margin-top:10px;padding:8px 10px;background:#0f172a;border-radius:6px;border:1px solid #334155;'>";
      html += "<div style='font-size:10px;color:#64748b;margin-bottom:4px;'>IN VIEW BUT NO SIGNAL LOCK (" + String(noSignal) + ")</div>";
      html += "<div style='font-size:11px;color:#475569;font-family:monospace;'>";
      bool first = true;
      for (int i = 0; i < trackedSatCount; i++) {
        if (trackedSats[i].snr == 0) {
          if (!first) html += ", ";
          const char* cn = "?";
          switch (trackedSats[i].constellation) {
            case 'G': cn = "GP"; break;
            case 'R': cn = "GL"; break;
            case 'E': cn = "GA"; break;
            case 'B': cn = "BD"; break;
          }
          html += String(cn) + String(trackedSats[i].prn);
          if (trackedSats[i].elev >= 0 && trackedSats[i].azim >= 0) {
            html += "(" + String(trackedSats[i].elev) + "/" + String(trackedSats[i].azim) + ")";
          }
          first = false;
        }
      }
      html += "</div></div>";
    }

    html += F("<div style='margin-top:12px;padding:8px;background:#0f172a;border-radius:6px;border:1px solid #334155;font-size:10px;color:#64748b;text-align:center;'>"
             "SNR: "
             "<span style='color:#ef4444;'>&#9679; &lt;15 Very Weak</span> &middot; "
             "<span style='color:#f97316;'>&#9679; 15-19 Weak</span> &middot; "
             "<span style='color:#eab308;'>&#9679; 20-29 Moderate</span> &middot; "
             "<span style='color:#22c55e;'>&#9679; 30-39 Solid</span> &middot; "
             "<span style='color:#10b981;'>&#9679; 40+ Strong</span>"
             "</div>");
  }
  html += F("</div>");

  // --- 8. Raw NMEA Streams ---
  html += F("<div class='box'><h2>Raw 1Hz NMEA Log (Latest)</h2>");
  if (rawLineCount == 0) {
    html += F("<div class='bad'>Waiting for NMEA sentences...</div>");
  } else {
    for (int i = 0; i < rawLineCount; i++) {
      html += "<div class='raw'>" + rawLines[i] + "</div>";
    }
  }
  html += F("</div>");

  html += F("<div style='color:#475569;font-size:11px;margin-top:10px;'>Auto-refreshing view every 1 second...</div>");
  html += F("</body></html>");
  return html;
}


void handleRoot() {
  server.send(200, "text/html", buildPage());
}

void setup() {
  Serial.begin(115200);
  delay(1500);
  Serial.println(F("\n=== ESP32-S3 NEO-M8N GNSS Lab Setup ==="));

  // Initialize GPS UART with 1024-byte RX buffer and configure M8N
  GPSSerial.setRxBufferSize(2048);  // Larger buffer for full GSV blocks
  GPSSerial.begin(GPS_BAUD, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
  Serial.println(F("[GPS] UART serial started. Sending optimized configurations..."));
  configureM8NGPS();

  bootTime = millis();

  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, AP_PASS);
  IPAddress ip = WiFi.softAPIP();

  Serial.println(F("============================="));
  Serial.print(F("Connect to WiFi AP: ")); Serial.println(AP_SSID);
  Serial.print(F("Password: "));        Serial.println(AP_PASS);
  Serial.print(F("Access Diagnostics at: http://"));
  Serial.println(ip);
  Serial.println(F("=============================\n"));

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
      if (currentRawLine.length() > 0) {
        addRawLine(currentRawLine);
        parseGSV(currentRawLine);
        
        if (currentRawLine.indexOf("GGA") != -1) {
          parseGGA(currentRawLine);
        } else if (currentRawLine.indexOf("GSA") != -1) {
          parseGSA(currentRawLine);
        } else if (currentRawLine.indexOf("RMC") != -1) {
          parseRMC(currentRawLine);
        }

        Serial.print("[Raw NMEA] ");
        Serial.println(currentRawLine);
      }
      currentRawLine = "";
    } else if (c != '\r') {
      currentRawLine += c;
      if (currentRawLine.length() > 160) currentRawLine = "";
    }
  }

  // --- Speed & Altitude filtering (run every 1s to match 1Hz GPS rate) ---
  static unsigned long lastFilterUpdate = 0;
  if (millis() - lastFilterUpdate > 1000) {
    lastFilterUpdate = millis();

    if (gps.speed.isValid() && gps.speed.isUpdated()) {
      double hdop = gps.hdop.isValid() ? gps.hdop.hdop() : 5.0;
      processSpeedSample(gps.speed.kmph(), hdop);
    }

    if (gps.altitude.isValid() && gps.altitude.isUpdated()) {
      processAltitudeSample(gps.altitude.meters());
    }
  }

  // --- Periodic serial status ---
  static unsigned long lastStatusPrint = 0;
  if (millis() - lastStatusPrint > 5000) {
    lastStatusPrint = millis();
    int sats = gps.satellites.isValid() ? gps.satellites.value() : 0;
    double hdop = gps.hdop.isValid() ? gps.hdop.hdop() : 99.0;
    double lat = gps.location.isValid() ? gps.location.lat() : 0.0;
    double lng = gps.location.isValid() ? gps.location.lng() : 0.0;
    Serial.printf("[GNSS Stats] Sats:%d HDOP:%.2f Lat:%.6f Lng:%.6f Fix:%s Speed:%.1f->%.1f km/h Alt:%.1f m\n",
      sats, hdop, lat, lng, gps.location.isValid() ? "YES" : "NO",
      rawSpeedLast, filteredSpeed, filteredAlt);
  }

  server.handleClient();
}
