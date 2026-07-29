/*
  =====================================================================
  SW-520D Tamper Detection System — ESP32
  =====================================================================
  Simulates a tamper-protected box/enclosure using an SW-520D tilt
  switch as the sensing element.

  Behavior:
    - System can be ARMED or DISARMED via serial command.
    - When ARMED, the system counts switch transitions (edges) in a
      short rolling time window. A single accidental bump produces
      only 1-2 edges and is IGNORED. Real movement/shaking/handling
      of the box produces a burst of several edges in quick succession
      (the ball inside keeps re-triggering the contact) and DOES fire
      an alert. This correctly ignores stray nudges while still
      reliably catching actual pickup/movement.
    - Tamper state LATCHES (stays in ALERT) until acknowledged, even
      if the box is set back down / returns to its resting position.
    - LED gives a visual status indicator; onboard LED used by default.
    - All events are timestamped and logged over Serial.

  Wiring:
    SW-520D  -> one leg to GPIO 14, other leg to GND
                (INPUT_PULLUP used, so no external resistor needed)
    LED      -> GPIO 2 (ESP32 onboard LED on most dev boards)
                swap to an external LED + resistor if your board
                doesn't have one on GPIO 2

  Serial commands (115200 baud, send as plain text + newline):
    a  -> ARM the system
    d  -> DISARM the system
    r  -> RESET / acknowledge a tamper alert (clears latch, re-arms)
    s  -> print current STATUS

  Tuning sensitivity:
    EDGE_THRESHOLD -> how many switch transitions must occur inside
                       EDGE_WINDOW_MS before it's called real tamper.
                       Higher = less sensitive to a single stray bump,
                       but still catches real shaking/movement because
                       that produces many edges rapidly.
                         2-3  -> triggers on even a light nudge
                         4-5  -> ignores single bumps, catches real
                                 movement (good default)
                         6+   -> requires more vigorous handling
    EDGE_WINDOW_MS  -> the time window edges are counted within.
                        Shorter = must happen in a tighter burst.
    EDGE_DEBOUNCE_MS -> filters pure electrical/contact noise only,
                        keep this small (10-20ms) so it doesn't eat
                        real bounces during genuine shaking.
  =====================================================================
*/

#include <Arduino.h>

// ---------------- Pin configuration ----------------
#define TILT_PIN   14
#define LED_PIN    2

// ---------------- Timing configuration ----------------
#define EDGE_DEBOUNCE_MS     15     // filters electrical contact noise only
#define EDGE_WINDOW_MS       700    // time window edges are counted within
#define EDGE_THRESHOLD       4      // <-- SENSITIVITY KNOB. edges needed
                                     //     inside the window to confirm tamper
#define MAX_EDGE_BUFFER      20     // ring buffer size for edge timestamps
#define HEARTBEAT_MS         5000   // "still watching" print interval while armed
#define LED_ARMED_BLINK_MS   1000   // slow blink while armed, idle
#define LED_ALERT_BLINK_MS   150    // fast blink while in alert
#define CHECK_INTERVAL_MS    50     // how often loop() re-checks the edge window

// ---------------- System state ----------------
enum SystemState {
  DISARMED,
  ARMED,
  TAMPER_ALERT
};

SystemState currentState = DISARMED;

unsigned long lastHeartbeat = 0;
unsigned long lastLedToggle = 0;
unsigned long lastCheck = 0;
bool ledState = false;

unsigned int tamperEventCount = 0;
unsigned long firstTamperTime = 0;
unsigned long lastTamperTime = 0;

// Ring buffer of recent edge timestamps, filled by the ISR
volatile unsigned long edgeTimestamps[MAX_EDGE_BUFFER];
volatile int edgeHead = 0;
volatile int edgeCountTotal = 0; // total edges ever recorded (wraps in buffer)
volatile unsigned long lastEdgeMillis = 0;

// ---------------- ISR ----------------
void IRAM_ATTR onTiltChange() {
  unsigned long now = millis();
  // Minimal debounce: filters only true electrical contact chatter
  // (sub-15ms), NOT the real mechanical bounce that happens during
  // genuine shaking/movement — that's exactly what we want to count.
  if (now - lastEdgeMillis >= EDGE_DEBOUNCE_MS) {
    edgeTimestamps[edgeHead] = now;
    edgeHead = (edgeHead + 1) % MAX_EDGE_BUFFER;
    edgeCountTotal++;
    lastEdgeMillis = now;
  }
}

// Count how many recorded edges fall within the last EDGE_WINDOW_MS
int countRecentEdges(unsigned long now) {
  int count = 0;
  noInterrupts();
  int total = edgeCountTotal;
  int samples = total < MAX_EDGE_BUFFER ? total : MAX_EDGE_BUFFER;
  int idx = edgeHead;
  unsigned long snapshot[MAX_EDGE_BUFFER];
  for (int i = 0; i < samples; i++) {
    idx = (idx - 1 + MAX_EDGE_BUFFER) % MAX_EDGE_BUFFER;
    snapshot[i] = edgeTimestamps[idx];
  }
  interrupts();

  for (int i = 0; i < samples; i++) {
    if (now - snapshot[i] <= EDGE_WINDOW_MS) {
      count++;
    } else {
      break; // timestamps are in descending recency order
    }
  }
  return count;
}

// ---------------- Helpers ----------------
void printTimestamp() {
  unsigned long ms = millis();
  unsigned long s = ms / 1000;
  unsigned long m = s / 60;
  unsigned long h = m / 60;
  Serial.printf("[%02lu:%02lu:%02lu.%03lu] ", h, m % 60, s % 60, ms % 1000);
}

void enterTamperAlert() {
  currentState = TAMPER_ALERT;
  tamperEventCount++;
  lastTamperTime = millis();
  if (tamperEventCount == 1) {
    firstTamperTime = lastTamperTime;
  }

  printTimestamp();
  Serial.println("*** TAMPER DETECTED *** Box was moved/tilted while ARMED.");
  printTimestamp();
  Serial.printf("Event #%u logged. Send 'r' to acknowledge and re-arm.\n", tamperEventCount);
}

void armSystem() {
  currentState = ARMED;
  // Clear any stale edge history so old bumps from before arming
  // can't immediately trip a fresh alert.
  noInterrupts();
  edgeCountTotal = 0;
  edgeHead = 0;
  interrupts();

  printTimestamp();
  Serial.println("System ARMED. Monitoring for tamper events...");
}

void disarmSystem() {
  currentState = DISARMED;
  digitalWrite(LED_PIN, LOW);
  printTimestamp();
  Serial.println("System DISARMED. Box can be handled freely.");
}

void resetAlert() {
  if (currentState == TAMPER_ALERT) {
    printTimestamp();
    Serial.println("Alert acknowledged. Re-arming system.");
  }
  armSystem();
}

void printStatus() {
  printTimestamp();
  Serial.print("STATUS: ");
  switch (currentState) {
    case DISARMED:     Serial.println("DISARMED"); break;
    case ARMED:        Serial.println("ARMED (watching)"); break;
    case TAMPER_ALERT:
      Serial.printf("TAMPER_ALERT (event #%u)\n", tamperEventCount);
      break;
  }
  if (tamperEventCount > 0) {
    printTimestamp();
    Serial.printf("Total tamper events this session: %u | Last at %lu ms\n",
                  tamperEventCount, lastTamperTime);
  }
}

// ---------------- LED status pattern ----------------
void updateLed() {
  unsigned long now = millis();

  switch (currentState) {
    case DISARMED:
      digitalWrite(LED_PIN, LOW);
      break;

    case ARMED:
      if (now - lastLedToggle >= LED_ARMED_BLINK_MS) {
        ledState = !ledState;
        digitalWrite(LED_PIN, ledState);
        lastLedToggle = now;
      }
      break;

    case TAMPER_ALERT:
      if (now - lastLedToggle >= LED_ALERT_BLINK_MS) {
        ledState = !ledState;
        digitalWrite(LED_PIN, ledState);
        lastLedToggle = now;
      }
      break;
  }
}

// ---------------- Serial command handling ----------------
void handleSerialCommands() {
  if (!Serial.available()) return;

  char c = Serial.read();
  switch (c) {
    case 'a': case 'A':
      if (currentState == TAMPER_ALERT) {
        Serial.println("Cannot ARM directly from alert state. Send 'r' to acknowledge first.");
      } else {
        armSystem();
      }
      break;

    case 'd': case 'D':
      disarmSystem();
      break;

    case 'r': case 'R':
      resetAlert();
      break;

    case 's': case 'S':
      printStatus();
      break;

    default:
      // ignore newlines / unknown chars
      break;
  }
}

// ---------------- Setup ----------------
void setup() {
  Serial.begin(115200);
  delay(1000);

  pinMode(TILT_PIN, INPUT_PULLUP);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  // This was missing — without it, onTiltChange() never runs and
  // no edges are ever recorded, so tamper could never be detected.
  attachInterrupt(digitalPinToInterrupt(TILT_PIN), onTiltChange, CHANGE);

  Serial.println("=====================================================");
  Serial.println(" SW-520D Tamper Detection System — Ready");
  Serial.println("=====================================================");
  Serial.println("Commands: a=arm  d=disarm  r=reset/ack  s=status");
  Serial.println("System starting DISARMED. Send 'a' to begin monitoring.");
  Serial.println("=====================================================");
}

// ---------------- Main loop ----------------
void loop() {
  handleSerialCommands();

  unsigned long now = millis();

  // Periodically check whether recent edges (recorded by the ISR)
  // cross the burst threshold. This is the edge-counting design the
  // rest of the file (EDGE_THRESHOLD/EDGE_WINDOW_MS, countRecentEdges)
  // was built for.
  if (currentState == ARMED && now - lastCheck >= CHECK_INTERVAL_MS) {
    lastCheck = now;
    if (countRecentEdges(now) >= EDGE_THRESHOLD) {
      enterTamperAlert();
    }
  }

  // Periodic "still watching" heartbeat while armed and quiet
  if (currentState == ARMED && now - lastHeartbeat >= HEARTBEAT_MS) {
    lastHeartbeat = now;
    printTimestamp();
    Serial.println("Heartbeat: armed, no tamper.");
  }

  updateLed();
}
