/*
 * 0dh.in device gateway (Arduino IDE · esp32 core 3.x · board "ESP32 Dev Module",
 * or "ESP32S3 Dev Module", which uses RX pins 18 and 16 instead; see Settings)
 *
 * Collects the readings its controllers send over serial (firmware/PROTOCOL.md)
 * and, once a second, sends them to the portal as one HL7 PCD-01 ORU^R01
 * message, exactly as a device on a patient would (docs/vigil/esp32.md).
 * PROFILE (Settings) picks what it is attached to:
 *   PROFILE_ECMO    the ECMO controller ($EC) and the heater unit ($HU)
 *   PROFILE_VITALS  a patient monitor ($VS): SpO2, temperature or multi-parameter The server cannot tell dummy readings
 * from real ones, so nothing changes there when real sensors are connected.
 *
 *   ECMO controller / monitor TX ─────────► GPIO 25 (Serial1 RX)
 *   Heater controller TX ──[1k/2k divider]► GPIO 16 (Serial2 RX, ECMO profile)
 *   GND ──────────────────────────────────── GND (all boards together)
 *
 * Set-up: copy secrets.example.h to secrets.h (same folder) and fill it in.
 * DEMO_SOURCES 1 makes the gateway generate its controllers' lines itself,
 * so the whole server path can be checked before anything is wired.
 *
 * No extra libraries: WiFi, HTTPClient and WiFiClientSecure come with the
 * esp32 core. Everything runs in loop(); the product version moves to ESP-IDF
 * (tasks, watchdog, encrypted credentials, OTA) with the same structure:
 * links -> latest values -> message queue -> sender.
 */
#include <Arduino.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <math.h>
#include <time.h>

#include "root_cas.h"
#include "secrets.h"  // copy secrets.example.h to secrets.h

// ---------------- Settings ----------------
#define DEMO_SOURCES 1                 // 1 = simulate the controllers, 0 = read the serial links

#define PROFILE_ECMO 1                 // ECMO controller ($EC) + heater unit ($HU)
#define PROFILE_VITALS 2               // patient monitor ($VS): SpO2, temperature or multi-parameter
#define PROFILE PROFILE_ECMO           // what this board is attached to

#if CONFIG_IDF_TARGET_ESP32S3          // ESP32-S3 boards have no GPIO 25/26
const int ECMO_RX_PIN = 18;            // Serial1 RX <- ECMO controller TX
const int ECMO_TX_PIN = 17;            // Serial1 TX (unused today)
const int HU_RX_PIN = 16;              // Serial2 RX <- heater controller TX (via divider)
const int HU_TX_PIN = 15;              // Serial2 TX (unused today)
#else                                  // ESP32 (ESP32 Dev Module, WROOM-32)
const int ECMO_RX_PIN = 25;            // Serial1 RX <- ECMO controller TX
const int ECMO_TX_PIN = 26;            // Serial1 TX (unused today; kept off the flash pins)
const int HU_RX_PIN = 16;              // Serial2 RX <- heater controller TX (via divider)
const int HU_TX_PIN = 17;              // Serial2 TX (unused today)
#endif
const uint32_t LINK_BAUD = 115200;

const uint32_t FRAME_MS = 1000;        // one HL7 message per second
const uint32_t FRESH_MS = 3000;        // a controller silent this long is left out of messages
const size_t QUEUE_LEN = 300;          // ~5 minutes of messages kept while offline
const size_t BATCH_MAX = 20;           // messages per request when catching up
const uint32_t STATUS_MS = 10000;      // status line on the Serial monitor

// ---------------- Readings (field order = the $EC / $HU / $VS line order) ----------------
struct Field {
  const char *code;   // Vigil signal name, sent as "<code>^<code>^0DH"
  const char *ucum;   // unit, exactly as the server expects it
  uint8_t decimals;
};

const Field EC_FIELDS[] = {
  {"ECMO_BLOOD_FLOW", "L/min", 2},
  {"ECMO_PUMP_SPEED", "{rpm}", 0},
  {"ECMO_P_VENOUS", "mm[Hg]", 0},
  {"ECMO_P_PRE_OXY", "mm[Hg]", 0},
  {"ECMO_P_POST_OXY", "mm[Hg]", 0},
  {"ECMO_OXY_DELTA_P", "mm[Hg]", 0},
  {"ECMO_SWEEP_FLOW", "L/min", 1},
  {"ECMO_FIO2", "%", 0},
  {"ECMO_BLOOD_TEMP", "Cel", 1},
  {"ECMO_BUBBLE_ALARM", "{flag}", 0},
  {"ECMO_LEVEL_ALARM", "{flag}", 0},
};
const Field HU_FIELDS[] = {
  {"HU_WATER_TEMP", "Cel", 1},
  {"HU_SET_TEMP", "Cel", 1},
  {"HU_WATER_LEVEL", "%", 1},
  {"HU_WATER_FLOW", "L/min", 2},
  {"HU_WATER_PRESSURE", "bar", 3},
  {"HU_GT38_ON", "{flag}", 0},
  {"HU_LOW_WATER", "{flag}", 0},
};
const Field VS_FIELDS[] = {
  {"VITAL_SPO2", "%", 0},
  {"VITAL_PULSE_RATE", "{beats}/min", 0},
  {"VITAL_HEART_RATE", "{beats}/min", 0},
  {"VITAL_TEMP", "Cel", 1},
  {"VITAL_NIBP_SYS", "mm[Hg]", 0},
  {"VITAL_NIBP_DIA", "mm[Hg]", 0},
  {"VITAL_NIBP_MEAN", "mm[Hg]", 0},
  {"VITAL_RESP_RATE", "{breaths}/min", 0},
  {"VITAL_PERFUSION_INDEX", "%", 1},
};
const size_t EC_COUNT = sizeof(EC_FIELDS) / sizeof(EC_FIELDS[0]);
const size_t HU_COUNT = sizeof(HU_FIELDS) / sizeof(HU_FIELDS[0]);
const size_t VS_COUNT = sizeof(VS_FIELDS) / sizeof(VS_FIELDS[0]);
const size_t MAX_FIELDS = 11;

struct Source {
  const char *tag;          // "EC", "HU" or "VS"
  const char *name;         // for the Serial monitor
  const Field *fields;
  size_t count;
  HardwareSerial *port;
  char line[128];
  size_t len;
  float values[MAX_FIELDS]; // NAN = not fitted
  uint32_t heardAt;
  bool heard;
  uint32_t good, bad;
};

#if PROFILE == PROFILE_VITALS
Source sources[] = {
  {"VS", "Monitor", VS_FIELDS, VS_COUNT, &Serial1, {0}, 0, {0}, 0, false, 0, 0},
};
const char *OBR_SERVICE = "VITALS^Patient monitoring^0DH";
#else
Source sources[] = {
  {"EC", "ECMO", EC_FIELDS, EC_COUNT, &Serial1, {0}, 0, {0}, 0, false, 0, 0},
  {"HU", "Heater", HU_FIELDS, HU_COUNT, &Serial2, {0}, 0, {0}, 0, false, 0, 0},
};
const char *OBR_SERVICE = "ECMO^ECMO monitoring^0DH";
#endif
const size_t SOURCE_COUNT = sizeof(sources) / sizeof(sources[0]);
const size_t MAX_SOURCES = 2;

/** One second's readings, waiting to be sent. Declared before any function:
    the Arduino IDE puts its generated function prototypes there. */
struct Snapshot {
  uint32_t no;                       // message control id
  time_t t;                          // UTC seconds
  bool fresh[MAX_SOURCES];           // which controllers were heard recently
  float v[MAX_SOURCES][MAX_FIELDS];  // their latest values (NAN = not fitted)
};

uint8_t xorSum(const char *s, size_t n) {
  uint8_t c = 0;
  for (size_t i = 0; i < n; i++) c ^= (uint8_t)s[i];
  return c;
}

/** "$TAG,v1,v2,...*XX": checksum, tag and field count must all match, else the line is dropped. */
bool parseLine(Source &src, char *line) {
  size_t n = strlen(line);
  while (n && (line[n - 1] == '\r' || line[n - 1] == ' ')) line[--n] = 0;
  if (n < 6 || line[0] != '$') return false;
  char *star = strrchr(line, '*');
  if (!star || star - line < 2 || strlen(star) != 3) return false;
  char *end;
  long sum = strtol(star + 1, &end, 16);
  if (*end || sum != xorSum(line + 1, star - line - 1)) return false;
  *star = 0;

  char *comma = strchr(line + 1, ',');
  if (!comma) return false;
  *comma = 0;
  if (strcmp(line + 1, src.tag) != 0) return false;

  float vals[MAX_FIELDS];
  char *p = comma + 1;
  for (size_t i = 0; i < src.count; i++) {
    if (!p) return false;                  // too few fields
    char *next = strchr(p, ',');
    if (next) *next = 0;
    if (*p == 0) {
      vals[i] = NAN;                       // empty field: not fitted
    } else {
      char *e;
      float v = strtof(p, &e);
      if (*e || !isfinite(v)) return false;
      vals[i] = v;
    }
    p = next ? next + 1 : nullptr;
  }
  if (p) return false;                     // too many fields
  memcpy(src.values, vals, sizeof(float) * src.count);
  src.heardAt = millis();
  src.heard = true;
  return true;
}

void pollSource(Source &src) {
  while (src.port->available()) {
    char ch = (char)src.port->read();
    if (ch == '\n') {
      src.line[src.len] = 0;
      if (src.len) {
        if (parseLine(src, src.line)) src.good++;
        else src.bad++;
      }
      src.len = 0;
    } else if (src.len < sizeof(src.line) - 1) {
      src.line[src.len++] = ch;
    } else {
      src.len = 0;                         // overlong: drop it
      src.bad++;
    }
  }
}

bool fresh(const Source &src) { return src.heard && millis() - src.heardAt <= FRESH_MS; }

#if DEMO_SOURCES
// ---------------- Demo: the controllers simulated here ----------------
void feedDemo(Source &src, const char *body) {
  char line[128];
  snprintf(line, sizeof(line), "$%s*%02X", body, xorSum(body, strlen(body)));
  if (parseLine(src, line)) src.good++;
  else src.bad++;
}

#if PROFILE == PROFILE_VITALS
// A patient monitor: saturation, pulse and NIBP drift gently; respiration and
// temperature slower. A SpO2- or temperature-only monitor sends empty fields.
void demoTick() {
  const float t = millis() / 1000.0f;
  const float spo2 = 96.0f + sinf(t / 13.0f) * 2.0f + random(-1, 2) * 0.4f;
  const float pr = 82.0f + sinf(t / 9.0f) * 5.0f + random(-1, 2);
  const float sys = 118.0f + sinf(t / 30.0f) * 6.0f;
  const float dia = 76.0f + sinf(t / 30.0f) * 4.0f;
  char body[112];
  snprintf(body, sizeof(body), "VS,%.0f,%.0f,%.0f,%.1f,%.0f,%.0f,%.0f,%.0f,%.1f", spo2, pr, pr - 1.0f,
           36.9f + sinf(t / 60.0f) * 0.2f, sys, dia, (sys + 2.0f * dia) / 3.0f, 16.0f + sinf(t / 11.0f) * 2.0f,
           2.4f + sinf(t / 7.0f) * 0.4f);
  feedDemo(sources[0], body);
}
#else
void demoTick() {
  Source &ecmo = sources[0];
  Source &heater = sources[1];
  static float huTemp = 30.0f, huLevel = 90.0f;
  static bool refilling = false;
  static uint32_t lastSetpoint = 0;
  static int spIndex = 0;
  const float setpoints[] = {37.0f, 36.0f, 38.5f, 35.0f};
  const uint32_t now = millis();
  const float t = now / 1000.0f;

  // Heater unit, like the HU display sketch: temperature follows the
  // setpoint, the water level drains and refills, flow and pressure follow.
  if (now - lastSetpoint > 60000) {
    lastSetpoint = now;
    spIndex = (spIndex + 1) % 4;
  }
  const float huSet = setpoints[spIndex];
  huTemp += (huSet - huTemp) * 0.15f + random(-3, 4) / 100.0f;
  if (refilling) {
    huLevel += 10.0f;
    if (huLevel >= 95.0f) refilling = false;
  } else {
    huLevel -= 1.25f;
    if (huLevel <= 10.0f) refilling = true;
  }
  const bool lowWater = huLevel < 20.0f;
  const float huFlow = lowWater ? 0.0f : 2.4f + sinf(t / 10.0f) * 0.6f;
  const float huPressure = lowWater ? 0.0f : 0.08f + huFlow * 0.06f + random(-3, 4) / 1000.0f;

  char body[112];
  snprintf(body, sizeof(body), "HU,%.1f,%.1f,%.1f,%.2f,%.3f,%d,%d", huTemp, huSet, huLevel, huFlow, huPressure,
           huSet > 38.0f ? 1 : 0, lowWater ? 1 : 0);
  feedDemo(heater, body);

  // ECMO console: a steady run with small natural variation.
  const float flow = 4.2f + sinf(t / 7.0f) * 0.15f + random(-2, 3) / 100.0f;
  const float rpm = 3200.0f + sinf(t / 7.0f) * 60.0f + random(-10, 11);
  const float pVenous = -40.0f - sinf(t / 7.0f) * 4.0f + random(-2, 3);
  const float pPre = 230.0f + sinf(t / 9.0f) * 5.0f + random(-2, 3);
  const float pPost = 190.0f + sinf(t / 9.0f) * 4.0f + random(-2, 3);
  const float bloodTemp = 36.8f + sinf(t / 60.0f) * 0.1f;
  snprintf(body, sizeof(body), "EC,%.2f,%.0f,%.0f,%.0f,%.0f,%.0f,%.1f,%.0f,%.1f,0,0", flow, rpm, pVenous, pPre, pPost,
           pPre - pPost, 3.0f, 100.0f, bloodTemp);
  feedDemo(ecmo, body);
}
#endif
#endif

// ---------------- Message queue ----------------
Snapshot queueBuf[QUEUE_LEN];
size_t qHead = 0, qCount = 0;
uint32_t messageNo = 0, droppedOffline = 0;

void enqueue(const Snapshot &s) {
  if (qCount == QUEUE_LEN) {               // full: the oldest message gives way
    qHead = (qHead + 1) % QUEUE_LEN;
    qCount--;
    droppedOffline++;
  }
  queueBuf[(qHead + qCount) % QUEUE_LEN] = s;
  qCount++;
}

bool clockValid() { return time(nullptr) > 1700000000; }

void takeSnapshot() {
  if (!clockValid()) return;               // never send without a real time
  Snapshot s;
  bool any = false;
  for (size_t i = 0; i < SOURCE_COUNT; i++) {
    s.fresh[i] = fresh(sources[i]);
    any = any || s.fresh[i];
    memcpy(s.v[i], sources[i].values, sizeof(s.v[i]));
  }
  if (!any) return;                        // nothing to report: the server sees the gap
  s.no = ++messageNo;
  s.t = time(nullptr);
  enqueue(s);
}

// ---------------- HL7 PCD-01 ORU^R01 ----------------
String hl7Time(time_t t) {
  struct tm tm;
  gmtime_r(&t, &tm);
  char buf[24];
  strftime(buf, sizeof(buf), "%Y%m%d%H%M%S+0000", &tm);
  return String(buf);
}

void appendObx(String &out, int &setId, const Field &f, float v, const String &ts) {
  if (isnan(v)) return;                    // not fitted: no OBX
  char val[24];
  snprintf(val, sizeof(val), "%.*f", f.decimals, v);
  out += "OBX|";
  out += ++setId;
  out += "|NM|";
  out += f.code;
  out += '^';
  out += f.code;
  out += "^0DH||";
  out += val;
  out += '|';
  out += f.ucum;
  out += '^';
  out += f.ucum;
  out += "^UCUM|||||F|||";
  out += ts;
  out += '\r';
}

String buildFrame(const Snapshot &s) {
  const String ts = hl7Time(s.t);
  char ctrl[16];
  snprintf(ctrl, sizeof(ctrl), "GW%08lu", (unsigned long)s.no);
  String f;
  f.reserve(1800);
  f += "MSH|^~\\&|ESP32GW|";
  f += MACHINE_CODE;
  f += "|0DH|PORTAL|";
  f += ts;
  f += "||ORU^R01^ORU_R01|";
  f += ctrl;
  f += "|P|2.6\r";
  f += "OBR|1|||";
  f += OBR_SERVICE;
  f += "|||";
  f += ts;
  f += '\r';
  int setId = 0;
  for (size_t k = 0; k < SOURCE_COUNT; k++) {
    if (!s.fresh[k]) continue;
    for (size_t i = 0; i < sources[k].count; i++) appendObx(f, setId, sources[k].fields[i], s.v[k][i], ts);
  }
  return f;
}

// ---------------- Sending ----------------
WiFiClientSecure tlsClient;
WiFiClient plainClient;
HTTPClient http;
const bool useHttps = strncmp(SERVER_URL, "https://", 8) == 0;
uint32_t nextSendAt = 0;
String lastResult = "nothing sent yet";

void appendJsonString(String &out, const String &s) {
  out += '"';
  for (size_t i = 0; i < s.length(); i++) {
    const char c = s[i];
    if (c == '\\' || c == '"') {
      out += '\\';
      out += c;
    } else if (c == '\r') {
      out += "\\r";
    } else if (c == '\n') {
      out += "\\n";
    } else {
      out += c;
    }
  }
  out += '"';
}

int jsonInt(const String &body, const char *key) {
  const int at = body.indexOf(key);
  return at < 0 ? -1 : body.substring(at + strlen(key)).toInt();
}

/** The server's reason for the first rejected message (HL7 "MSA|AE|<id>|<reason>"). */
String firstRejection(const String &body) {
  int at = body.indexOf("MSA|AE|");
  if (at < 0) return "";
  at = body.indexOf('|', at + 7);
  if (at < 0) return "";
  int end = at + 1;
  while (end < (int)body.length() && body[end] != '\\' && body[end] != '"') end++;
  return body.substring(at + 1, end);
}

void dropFromQueue(size_t n) {
  qHead = (qHead + n) % QUEUE_LEN;
  qCount -= n;
}

void sendPending() {
  if (!qCount || (int32_t)(millis() - nextSendAt) < 0 || WiFi.status() != WL_CONNECTED) return;
  const size_t n = qCount < BATCH_MAX ? qCount : BATCH_MAX;
  String body;
  body.reserve(n * 1900 + 48);
  body += "{\"driver\":\"hl7_pcd01\",\"frames\":[";
  for (size_t i = 0; i < n; i++) {
    if (i) body += ',';
    appendJsonString(body, buildFrame(queueBuf[(qHead + i) % QUEUE_LEN]));
  }
  body += "]}";

  const bool begun = useHttps ? http.begin(tlsClient, SERVER_URL) : http.begin(plainClient, SERVER_URL);
  if (!begun) {
    lastResult = "bad SERVER_URL";
    nextSendAt = millis() + 30000;
    return;
  }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Machine-Id", MACHINE_ID);
  http.addHeader("X-Machine-Token", MACHINE_TOKEN);
  const int code = http.POST(body);
  const String resp = code > 0 ? http.getString() : http.errorToString(code);
  http.end();

  if (code >= 200 && code < 300) {
    const int rejected = jsonInt(resp, "\"rejected\":");
    dropFromQueue(n);
    lastResult = String(code) + ", accepted " + jsonInt(resp, "\"accepted\":") + " of " + n;
    if (rejected > 0) Serial.printf("[send] server rejected %d message(s): %s\n", rejected, firstRejection(resp).c_str());
    nextSendAt = millis();                 // more queued? carry on next loop
  } else if (code == 401) {
    lastResult = "401: machine ID or token not accepted; check secrets.h";
    nextSendAt = millis() + 30000;
  } else if (code == 400) {
    lastResult = "400: request refused as malformed (messages dropped): " + resp.substring(0, 160);
    dropFromQueue(n);                      // retrying the same messages can never succeed
    nextSendAt = millis() + 5000;
  } else if (code == 403 || code == 404) {
    lastResult = String(code) + ": " + resp.substring(0, 160);
    nextSendAt = millis() + 30000;
  } else if (code == 429) {
    lastResult = "429: too many requests, slowing down";
    nextSendAt = millis() + 10000;
  } else {
    lastResult = String(code) + ": " + resp.substring(0, 120);  // network or server error: keep and retry
    nextSendAt = millis() + 5000;
  }
  if (code < 200 || code >= 300) Serial.printf("[send] %s\n", lastResult.c_str());
}

// ---------------- Status ----------------
void printLink(const Source &src) {
  if (!src.heard) Serial.printf(" | %s: never heard", src.name);
  else if (fresh(src)) Serial.printf(" | %s: ok", src.name);
  else Serial.printf(" | %s: SILENT %lus", src.name, (unsigned long)((millis() - src.heardAt) / 1000));
  Serial.printf(" (%lu good, %lu bad)", (unsigned long)src.good, (unsigned long)src.bad);
}

void printStatus() {
  if (WiFi.status() == WL_CONNECTED) Serial.printf("[gateway] Wi-Fi ok %d dBm", WiFi.RSSI());
  else Serial.print("[gateway] Wi-Fi connecting...");
  Serial.print(clockValid() ? " | clock ok" : " | waiting for time");
  for (size_t i = 0; i < SOURCE_COUNT; i++) printLink(sources[i]);
  Serial.printf(" | queued %u", (unsigned)qCount);
  if (droppedOffline) Serial.printf(" (%lu lost offline)", (unsigned long)droppedOffline);
  Serial.printf(" | last send: %s\n", lastResult.c_str());
}

// ---------------- Main ----------------
void setup() {
  Serial.begin(115200);
  Serial.println();
  Serial.printf("0dh.in %s gateway for %s -> %s%s\n", PROFILE == PROFILE_VITALS ? "patient monitor" : "ECMO", MACHINE_CODE, SERVER_URL,
                DEMO_SOURCES ? "  [DEMO_SOURCES: simulated controllers]" : "");

  Serial1.setRxBufferSize(2048);           // holds several seconds of lines while a send is in progress
  Serial1.begin(LINK_BAUD, SERIAL_8N1, ECMO_RX_PIN, ECMO_TX_PIN);
  Serial2.setRxBufferSize(2048);
  Serial2.begin(LINK_BAUD, SERIAL_8N1, HU_RX_PIN, HU_TX_PIN);

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  configTime(0, 0, "pool.ntp.org", "time.google.com");  // UTC; messages carry +0000

  tlsClient.setCACert(ROOT_CAS);
  http.setReuse(true);                     // keep the connection open between sends
  http.setTimeout(8000);
  randomSeed(esp_random());
}

void loop() {
#if !DEMO_SOURCES
  for (size_t i = 0; i < SOURCE_COUNT; i++) pollSource(sources[i]);
#endif
  static uint32_t lastFrame = 0, lastStatus = 0;
  const uint32_t now = millis();
  if (now - lastFrame >= FRAME_MS) {
    lastFrame = now;
#if DEMO_SOURCES
    demoTick();
#endif
    takeSnapshot();
  }
  sendPending();
  if (now - lastStatus >= STATUS_MS) {
    lastStatus = now;
    printStatus();
  }
}
