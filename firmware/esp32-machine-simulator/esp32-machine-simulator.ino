/*
 * 0dh.in machine simulator (Arduino IDE · esp32 core 3.x · board "ESP32S3 Dev Module")
 *
 * ONE ESP32 board that is several machines at once, each to the portal a
 * separate machine with its own ID and token, exactly as if six real devices
 * stood at the bedside:
 *
 *   ECMO    ECMO console + heater unit, the readings of the ECMO HMI
 *           (ESP32_DWIN_ECMO_EBOO_HMI): flow, pump, Pv, pre/post-oxygenator
 *           pressure, dP, sweep gas, FiO2, blood temperature, SvO2, alarms
 *   EBOO    EBOO pump and flow, heart rate, SpO2, ozone, UV and O2 (HMI page 05)
 *   SPO2    SpO2 monitor: SpO2, pulse rate, perfusion index
 *   TEMP    temperature monitor: body temperature
 *   MULTI   multi-parameter monitor: SpO2, pulse, heart rate, temperature,
 *           NIBP, respiration, perfusion index
 *   PUMP    infusion pump: learns its patient (and any order step) from the
 *           server like the real pump, accepts it, then reports flow rate,
 *           dispensed and remaining volume every 5 s
 *
 * A machine whose ID in secrets.h is left as zeros is not simulated, so any
 * mix of them (for example four of the six) can run.
 *
 * Every reading wanders randomly but stays inside the normal range: inside the
 * ECMO HMI's default alarm limits and away from the portal's ECMO rules (blood
 * flow never near 1.5 L/min, oxygenator dP without a trend), so no alarm is
 * raised. Numeric readings always carry a little noise, as real sensors do,
 * so the portal never flags a FLATLINE.
 *
 * Each monitoring machine sends one HL7 PCD-01 ORU^R01 message a second to
 * POST /vigil/ingest with its own X-Machine-Id / X-Machine-Token, the same
 * message the ESP32 gateway (firmware/esp32-ecmo-gateway) sends. The pump
 * uses the sync channel instead (POST /sync/pull and /sync/push,
 * docs/sync-contract.md). The server cannot tell these from real machines.
 *
 * ESP32-S3 N16R8 board settings (Tools menu):
 *   Board               ESP32S3 Dev Module
 *   Flash Size          16MB (128Mb)
 *   PSRAM               OPI PSRAM (not used by the sketch; any setting works)
 *   USB CDC On Boot     Enabled if the cable is in the port marked USB,
 *                       Disabled if it is in the port marked COM/UART
 *   Serial Monitor      115200
 *
 * Set-up: copy secrets.example.h to secrets.h (same folder) and fill it in.
 * No wiring and no extra libraries: WiFi, HTTPClient and WiFiClientSecure
 * come with the esp32 core.
 *
 * Serial Monitor commands (115200, Newline):
 *   help | status | off <code|all> | on <code|all>
 *   "off ECMO-001" stops that machine sending (the portal shows "No live
 *   data", and a confirmed ECMO raises the data-loss alarm); "on" resumes it.
 *
 * The pump never changes an order's steps: it runs the newest step the server
 * proposed (or, with none, a bag of saline / Ringer / dextrose) and reports
 * only its live status. Starting, pausing and completing steps stay with the
 * staff screens.
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
const size_t QUEUE_LEN = 120;          // per machine: 2 minutes of messages kept while offline
const size_t BATCH_MAX = 20;           // messages per request when catching up
const uint32_t STATUS_MS = 10000;      // status lines on the Serial Monitor

// ---------------- Readings ----------------
struct Field {
  const char *code;   // Vigil signal name, sent as "<code>^<code>^0DH"
  const char *ucum;   // unit, exactly as the server expects it
  uint8_t decimals;
};

// ECMO console + heater unit (index names keep the simulation readable)
enum { E_FLOW, E_RPM, E_PV, E_PRE, E_POST, E_DP, E_SWEEP, E_FIO2, E_TEMP, E_BUBBLE, E_LEVEL, E_SVO2,
       H_WTEMP, H_SET, H_LEVEL, H_FLOW, H_PRESS, H_GT38, H_LOW, ECMO_N };
const Field ECMO_FIELDS[ECMO_N] = {
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
  {"ECMO_SVO2", "%", 0},
  {"HU_WATER_TEMP", "Cel", 1},
  {"HU_SET_TEMP", "Cel", 1},
  {"HU_WATER_LEVEL", "%", 1},
  {"HU_WATER_FLOW", "L/min", 2},
  {"HU_WATER_PRESSURE", "bar", 3},
  {"HU_GT38_ON", "{flag}", 0},
  {"HU_LOW_WATER", "{flag}", 0},
};

// EBOO (a slow pump: about 13 rpm and 0.13 L/min, as on the HMI)
enum { B_RPM, B_FLOW, B_HR, B_SPO2, B_OZONE, B_OZONE_ON, B_UV_ON, B_O2_ON, B_BUBBLE, B_LEVEL, EBOO_N };
const Field EBOO_FIELDS[EBOO_N] = {
  {"ECMO_PUMP_SPEED", "{rpm}", 1},
  {"ECMO_BLOOD_FLOW", "L/min", 3},
  {"VITAL_HEART_RATE", "{beats}/min", 0},
  {"VITAL_SPO2", "%", 0},
  {"EBOO_OZONE_CONC", "ug/mL", 1},
  {"EBOO_OZONE_ON", "{flag}", 0},
  {"EBOO_UV_ON", "{flag}", 0},
  {"EBOO_O2_ON", "{flag}", 0},
  {"ECMO_BUBBLE_ALARM", "{flag}", 0},
  {"ECMO_LEVEL_ALARM", "{flag}", 0},
};

enum { S_SPO2, S_PR, S_PI, SPO2_N };
const Field SPO2_FIELDS[SPO2_N] = {
  {"VITAL_SPO2", "%", 0},
  {"VITAL_PULSE_RATE", "{beats}/min", 0},
  {"VITAL_PERFUSION_INDEX", "%", 1},
};

enum { T_TEMP, TEMP_N };
const Field TEMP_FIELDS[TEMP_N] = {
  {"VITAL_TEMP", "Cel", 1},
};

enum { V_SPO2, V_PR, V_HR, V_TEMP, V_SYS, V_DIA, V_MAP, V_RR, V_PI, MULTI_N };
const Field MULTI_FIELDS[MULTI_N] = {
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

const size_t MAX_FIELDS = ECMO_N;

enum Kind { K_ECMO, K_EBOO, K_SPO2, K_TEMP, K_MULTI };

/** One second's readings of one machine, waiting to be sent. Declared before any
    function: the Arduino IDE puts its generated function prototypes there. */
struct Snapshot {
  uint32_t no;                // message control id
  time_t t;                   // UTC seconds
  float v[MAX_FIELDS];
};

struct Machine {
  Kind kind;
  const char *type;           // the machine type it must be registered as in the portal
  const char *code, *id, *token;
  const char *service;        // HL7 OBR-4
  const Field *fields;
  size_t count;
  bool enabled;               // credentials filled in
  bool paused;                // "off" command
  float v[MAX_FIELDS];        // latest readings
  Snapshot queue[QUEUE_LEN];
  size_t qHead, qCount;
  uint32_t messageNo, sent, dropped, nextSendAt;
  String lastResult;
};

Machine machines[] = {
  {K_ECMO, "ECMO", ECMO_CODE, ECMO_ID, ECMO_TOKEN, "ECMO^ECMO monitoring^0DH", ECMO_FIELDS, ECMO_N},
  {K_EBOO, "EBOO", EBOO_CODE, EBOO_ID, EBOO_TOKEN, "EBOO^EBOO monitoring^0DH", EBOO_FIELDS, EBOO_N},
  {K_SPO2, "SpO2 monitor", SPO2_CODE, SPO2_ID, SPO2_TOKEN, "VITALS^Patient monitoring^0DH", SPO2_FIELDS, SPO2_N},
  {K_TEMP, "Temperature monitor", TEMP_CODE, TEMP_ID, TEMP_TOKEN, "VITALS^Patient monitoring^0DH", TEMP_FIELDS, TEMP_N},
  {K_MULTI, "Multi-parameter monitor", MULTI_CODE, MULTI_ID, MULTI_TOKEN, "VITALS^Patient monitoring^0DH", MULTI_FIELDS, MULTI_N},
};
const size_t MACHINE_COUNT = sizeof(machines) / sizeof(machines[0]);

bool credentialsFilled(const char *id, const char *token) {
  return strlen(id) == 36 && strcmp(id, "00000000-0000-0000-0000-000000000000") != 0 && strlen(token) == 64;
}

// ---------------- Simulation ----------------
float rnd(float lo, float hi) { return lo + (hi - lo) * (esp_random() / 4294967295.0f); }

/**
 * A reading that wanders inside [lo, hi]: each second it is pulled toward a
 * slowly drifting mean and gets a little noise. The mean stays in the middle
 * 60 % of the range, so the reading rarely touches a limit.
 */
struct Walk {
  float lo, hi, noise, pull, drift;
  float mean, v;
  bool started;

  Walk(float lo_, float hi_, float noise_, float pull_ = 0.1f, float drift_ = 0.0f)
      : lo(lo_), hi(hi_), noise(noise_), pull(pull_), drift(drift_), mean((lo_ + hi_) / 2), v((lo_ + hi_) / 2), started(false) {}

  float step() {
    const float margin = (hi - lo) * 0.2f;
    if (!started) {
      started = true;
      mean = v = rnd(lo + margin, hi - margin);
    }
    mean = constrain(mean + rnd(-drift, drift), lo + margin, hi - margin);
    v = constrain(v + pull * (mean - v) + rnd(-noise, noise), lo, hi);
    return v;
  }
};

/** A setting the operator changes now and then: one of the options, kept for 15-25 minutes. */
struct Setting {
  const float *options;
  size_t count;
  size_t index;
  uint32_t nextChangeAt;

  float value() {
    if (!nextChangeAt || (int32_t)(millis() - nextChangeAt) >= 0) {
      if (nextChangeAt) {                  // one step up or down, never past the ends
        const bool up = index == 0 || (index + 1 < count && esp_random() % 2);
        index = up ? index + 1 : index - 1;
      }
      nextChangeAt = millis() + (uint32_t)rnd(15 * 60000.0f, 25 * 60000.0f);
      if (!nextChangeAt) nextChangeAt = 1;
    }
    return options[index];
  }
};

// Ranges: inside the ECMO HMI's default alarm limits (flow 1.00-6.00 L/min, pump < 5000 rpm,
// Pv > -100, Pa < 300, Pin < 350, dP < 50 mmHg, temperature 35.0-38.5 C, SvO2 > 60 %).
void simulateEcmo(float *v) {
  static Walk rpm(2900, 3500, 12, 0.08f, 2), lpk(1.20f, 1.32f, 0.004f, 0.1f, 0.0005f);
  static Walk pv(-55, -20, 1.5f, 0.1f, 0.2f), post(165, 225, 2.0f, 0.1f, 0.3f);
  static Walk dp(15, 22, 0.8f, 0.2f, 0);                       // no drift: no oxygenator dP trend
  static Walk temp(36.4f, 37.2f, 0.06f, 0.05f, 0.002f), svo2(67, 80, 0.6f, 0.05f, 0.05f);
  static Walk huLevel(72, 94, 0.15f, 0.02f, 0.05f), huFlow(2.1f, 2.9f, 0.03f, 0.1f, 0.002f);
  static const float SWEEP[] = {2.5f, 3.0f, 3.5f};
  static const float FIO2[] = {60, 70, 80, 90, 100};
  static const float HU_SET[] = {36.5f, 37.0f, 37.5f};
  static Setting sweep = {SWEEP, 3, 1, 0}, fio2 = {FIO2, 5, 4, 0}, huSet = {HU_SET, 3, 1, 0};
  static float huTemp = 0;

  v[E_RPM] = rpm.step();
  v[E_FLOW] = v[E_RPM] / 1000.0f * lpk.step() + rnd(-0.02f, 0.02f);   // follows the pump
  v[E_PV] = pv.step();
  v[E_POST] = post.step() + (v[E_FLOW] - 4.0f) * 15.0f;
  v[E_DP] = dp.step();
  v[E_PRE] = v[E_POST] + v[E_DP];
  v[E_SWEEP] = sweep.value();
  v[E_FIO2] = fio2.value();
  v[E_TEMP] = temp.step();
  v[E_BUBBLE] = 0;
  v[E_LEVEL] = 0;
  v[E_SVO2] = svo2.step();

  const float set = huSet.value();
  if (!huTemp) huTemp = set;
  huTemp += (set - huTemp) * 0.05f + rnd(-0.05f, 0.05f);             // water follows the set temperature
  v[H_WTEMP] = huTemp;
  v[H_SET] = set;
  v[H_LEVEL] = huLevel.step();
  v[H_FLOW] = huFlow.step();
  v[H_PRESS] = 0.06f + v[H_FLOW] * 0.07f + rnd(-0.004f, 0.004f);
  v[H_GT38] = 0;
  v[H_LOW] = 0;
}

void simulateEboo(float *v) {
  static const float SPEED[] = {12, 13, 14, 15};
  static Setting speed = {SPEED, 4, 1, 0};
  static Walk hr(68, 92, 1.0f, 0.1f, 0.1f), spo2(95, 99, 0.6f, 0.1f, 0.02f), ozone(26, 38, 0.4f, 0.1f, 0.05f);

  v[B_RPM] = speed.value() + rnd(-0.15f, 0.15f);                      // tachometer noise around the set speed
  v[B_FLOW] = v[B_RPM] * 0.01f + rnd(-0.002f, 0.002f);               // L/min, as the HMI computes it
  v[B_HR] = hr.step();
  v[B_SPO2] = spo2.step();
  v[B_OZONE] = ozone.step();                                          // ug/mL (the HMI alarms above 70)
  v[B_OZONE_ON] = 1;
  v[B_UV_ON] = 1;
  v[B_O2_ON] = 1;
  v[B_BUBBLE] = 0;
  v[B_LEVEL] = 0;
}

void simulateSpo2(float *v) {
  static Walk spo2(94, 99, 0.6f, 0.1f, 0.02f), pr(64, 96, 1.0f, 0.1f, 0.1f), pi(1.2f, 4.5f, 0.08f, 0.1f, 0.01f);
  v[S_SPO2] = spo2.step();
  v[S_PR] = pr.step();
  v[S_PI] = pi.step();
}

void simulateTemp(float *v) {
  static Walk temp(36.4f, 37.3f, 0.07f, 0.05f, 0.002f);
  v[T_TEMP] = temp.step();
}

void simulateMulti(float *v) {
  static Walk spo2(94, 99, 0.6f, 0.1f, 0.02f), pr(64, 96, 1.0f, 0.1f, 0.1f), temp(36.4f, 37.3f, 0.07f, 0.05f, 0.002f);
  static Walk sys(108, 134, 0.8f, 0.05f, 0.1f), dia(66, 84, 0.5f, 0.05f, 0.08f), rr(12, 20, 0.4f, 0.1f, 0.02f);
  static Walk pi(1.2f, 4.5f, 0.08f, 0.1f, 0.01f);
  v[V_SPO2] = spo2.step();
  v[V_PR] = pr.step();
  v[V_HR] = constrain(v[V_PR] + rnd(-2, 2), 60.0f, 100.0f);           // ECG and oximeter agree within a few beats
  v[V_TEMP] = temp.step();
  v[V_SYS] = sys.step();
  v[V_DIA] = dia.step();
  v[V_MAP] = (v[V_SYS] + 2 * v[V_DIA]) / 3;
  v[V_RR] = rr.step();
  v[V_PI] = pi.step();
}

void simulate(Machine &m) {
  switch (m.kind) {
    case K_ECMO: simulateEcmo(m.v); break;
    case K_EBOO: simulateEboo(m.v); break;
    case K_SPO2: simulateSpo2(m.v); break;
    case K_TEMP: simulateTemp(m.v); break;
    case K_MULTI: simulateMulti(m.v); break;
  }
}

// ---------------- Message queues (one per machine) ----------------
void enqueue(Machine &m, time_t t) {
  if (m.qCount == QUEUE_LEN) {             // full: the oldest message gives way
    m.qHead = (m.qHead + 1) % QUEUE_LEN;
    m.qCount--;
    m.dropped++;
  }
  Snapshot &s = m.queue[(m.qHead + m.qCount) % QUEUE_LEN];
  s.no = ++m.messageNo;
  s.t = t;
  memcpy(s.v, m.v, sizeof(s.v));
  m.qCount++;
}

void dropFromQueue(Machine &m, size_t n) {
  m.qHead = (m.qHead + n) % QUEUE_LEN;
  m.qCount -= n;
}

bool clockValid() { return time(nullptr) > 1700000000; }

/** Once per clock second: every running machine takes its readings. */
void tick(time_t t) {
  for (size_t i = 0; i < MACHINE_COUNT; i++) {
    Machine &m = machines[i];
    if (!m.enabled) continue;
    simulate(m);                           // keeps moving while paused, so "on" resumes naturally
    if (!m.paused) enqueue(m, t);
  }
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

String buildFrame(const Machine &m, const Snapshot &s) {
  const String ts = hl7Time(s.t);
  char ctrl[16];
  snprintf(ctrl, sizeof(ctrl), "SM%08lu", (unsigned long)s.no);
  String f;
  f.reserve(1800);
  f += "MSH|^~\\&|ESP32SIM|";
  f += m.code;
  f += "|0DH|PORTAL|";
  f += ts;
  f += "||ORU^R01^ORU_R01|";
  f += ctrl;
  f += "|P|2.6\r";
  f += "OBR|1|||";
  f += m.service;
  f += "|||";
  f += ts;
  f += '\r';
  int setId = 0;
  for (size_t i = 0; i < m.count; i++) appendObx(f, setId, m.fields[i], s.v[i], ts);
  return f;
}

// ---------------- Sending ----------------
WiFiClientSecure tlsClient;
WiFiClient plainClient;
HTTPClient http;                           // one connection, kept open, shared by all machines
const bool useHttps = strncmp(SERVER_URL, "https://", 8) == 0;
size_t nextMachine = 0;

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

void sendFor(Machine &m) {
  const size_t n = m.qCount < BATCH_MAX ? m.qCount : BATCH_MAX;
  String body;
  body.reserve(n * 1900 + 48);
  body += "{\"driver\":\"hl7_pcd01\",\"frames\":[";
  for (size_t i = 0; i < n; i++) {
    if (i) body += ',';
    appendJsonString(body, buildFrame(m, m.queue[(m.qHead + i) % QUEUE_LEN]));
  }
  body += "]}";

  const bool begun = useHttps ? http.begin(tlsClient, SERVER_URL) : http.begin(plainClient, SERVER_URL);
  if (!begun) {
    m.lastResult = "bad SERVER_URL";
    m.nextSendAt = millis() + 30000;
    return;
  }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Machine-Id", m.id);
  http.addHeader("X-Machine-Token", m.token);
  const int code = http.POST(body);
  const String resp = code > 0 ? http.getString() : http.errorToString(code);
  http.end();

  if (code >= 200 && code < 300) {
    const int rejected = jsonInt(resp, "\"rejected\":");
    dropFromQueue(m, n);
    m.sent += n;
    m.lastResult = String(code) + ", accepted " + jsonInt(resp, "\"accepted\":") + " of " + n;
    if (rejected > 0) Serial.printf("[%s] server rejected %d message(s): %s\n", m.code, rejected, firstRejection(resp).c_str());
    m.nextSendAt = millis();
  } else if (code == 401) {
    m.lastResult = "401: machine ID or token not accepted; check secrets.h";
    m.nextSendAt = millis() + 30000;
  } else if (code == 400) {
    m.lastResult = "400: request refused as malformed (messages dropped): " + resp.substring(0, 160);
    dropFromQueue(m, n);                   // retrying the same messages can never succeed
    m.nextSendAt = millis() + 5000;
  } else if (code == 403 || code == 404) {
    // 403: the portal is in TEST mode, or the machine is registered as a type that does not send monitoring data
    m.lastResult = String(code) + ": " + resp.substring(0, 160);
    m.nextSendAt = millis() + 30000;
  } else if (code == 429) {
    m.lastResult = "429: too many requests, slowing down";
    m.nextSendAt = millis() + 10000;
  } else {
    m.lastResult = String(code) + ": " + resp.substring(0, 120);  // network or server error: keep and retry
    m.nextSendAt = millis() + 5000;
  }
  if (code < 200 || code >= 300) Serial.printf("[%s] %s\n", m.code, m.lastResult.c_str());
}

/** One request per call, taking the machines in turn, so a slow or refused machine never holds up the others. */
void sendPending() {
  if (WiFi.status() != WL_CONNECTED) return;
  for (size_t k = 0; k < MACHINE_COUNT; k++) {
    Machine &m = machines[(nextMachine + k) % MACHINE_COUNT];
    if (!m.enabled || !m.qCount || (int32_t)(millis() - m.nextSendAt) < 0) continue;
    nextMachine = (nextMachine + k + 1) % MACHINE_COUNT;
    sendFor(m);
    return;
  }
}

// ---------------- Infusion pump (sync channel: docs/sync-contract.md) ----------------
const uint32_t PUMP_PULL_MS = 10000;     // asks the server for new proposals (patient, order steps)
const uint32_t PUMP_STATUS_MS = 5000;    // live status report
const uint32_t PUMP_REST_MS = 60000;     // after a bag or step is finished, the next one starts a minute later

struct Bag {
  const char *drug;
  float volumeMl, rateMlPerH;
};
const Bag BAGS[] = {
  {"Normal Saline 0.9%", 500, 42},
  {"Ringer Lactate", 500, 60},
  {"Dextrose 5%", 250, 30},
};
const size_t BAG_COUNT = sizeof(BAGS) / sizeof(BAGS[0]);

struct Pump {
  const char *code, *id, *token;
  bool enabled, paused;
  String syncUrl;                          // SERVER_URL with /vigil/ingest replaced by /sync
  long sinceVersion;
  String patientId, patientName;
  String stepId;                           // empty: running a plain bag, not an order step
  String drug;
  float volumeMl, rateMlPerH, dispensedMl, infusedMin;
  bool finished;
  uint32_t finishedAt, lastPull, lastStatus, lastAdvance, nextTryAt;
  size_t bag;
  uint32_t sent;
  String lastResult;
} pump = {PUMP_CODE, PUMP_ID, PUMP_TOKEN};

/** "key":"value" in a JSON object's text (no nesting needed: the keys read here are unique in it). */
String jsonText(const String &obj, const char *key) {
  const String k = String("\"") + key + "\":\"";
  int at = obj.indexOf(k);
  if (at < 0) return "";
  String out;
  for (int i = at + k.length(); i < (int)obj.length(); i++) {
    const char c = obj[i];
    if (c == '"') break;
    if (c == '\\' && i + 1 < (int)obj.length()) out += obj[++i];  // \" and \\ (names need nothing more)
    else out += c;
  }
  return out;
}

/** "key":number in a JSON object's text, or NAN. */
float jsonNumber(const String &obj, const char *key) {
  const String k = String("\"") + key + "\":";
  const int at = obj.indexOf(k);
  if (at < 0) return NAN;
  const char c = obj[at + k.length()];
  if (c != '-' && (c < '0' || c > '9')) return NAN;  // null, string or missing
  return obj.substring(at + k.length()).toFloat();
}

/** The next {...} in an array starting at `from`; returns false at the end of the array. */
bool nextJsonObject(const String &s, int &from, String &obj) {
  int i = from;
  while (i < (int)s.length() && s[i] != '{' && s[i] != ']') i++;
  if (i >= (int)s.length() || s[i] == ']') return false;
  const int start = i;
  int depth = 0;
  bool inString = false;
  for (; i < (int)s.length(); i++) {
    const char c = s[i];
    if (inString) {
      if (c == '\\') i++;
      else if (c == '"') inString = false;
    } else if (c == '"') {
      inString = true;
    } else if (c == '{') {
      depth++;
    } else if (c == '}' && --depth == 0) {
      obj = s.substring(start, i + 1);
      from = i + 1;
      return true;
    }
  }
  return false;
}

String isoTime(time_t t) {
  struct tm tm;
  gmtime_r(&t, &tm);
  char buf[24];
  strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &tm);
  return String(buf);
}

void pumpStartBag() {
  const Bag &b = BAGS[pump.bag % BAG_COUNT];
  pump.bag++;
  pump.stepId = "";
  pump.drug = b.drug;
  pump.volumeMl = b.volumeMl;
  pump.rateMlPerH = b.rateMlPerH;
  pump.dispensedMl = b.volumeMl * rnd(0.1f, 0.4f);  // hung a while ago, so the screen is not always at 0
  pump.infusedMin = pump.dispensedMl / pump.rateMlPerH * 60.0f;
  pump.finished = false;
  pump.lastAdvance = millis();
}

/** POST to /sync/<path> as the pump; returns the HTTP code and the response body. */
int pumpPost(const char *path, const String &body, String &resp) {
  const String url = pump.syncUrl + path;
  const bool begun = useHttps ? http.begin(tlsClient, url) : http.begin(plainClient, url);
  if (!begun) {
    resp = "bad SERVER_URL";
    return -1;
  }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Machine-Id", pump.id);
  http.addHeader("X-Machine-Token", pump.token);
  const int code = http.POST(body);
  resp = code > 0 ? http.getString() : http.errorToString(code);
  http.end();
  return code;
}

/** Records a failed request; true when the code means success. */
bool pumpOk(const char *what, int code, const String &resp) {
  if (code >= 200 && code < 300) return true;
  pump.lastResult = String(what) + " " + code + ": " + resp.substring(0, 120);
  if (code == 401) pump.lastResult = String(what) + " 401: machine ID or token not accepted; check secrets.h";
  pump.nextTryAt = millis() + (code == 401 || code == 403 ? 30000 : 5000);
  Serial.printf("[%s] %s\n", pump.code, pump.lastResult.c_str());
  return false;
}

/**
 * Pull: the newest "patient" proposal is the patient this pump is on; an
 * "infusion_step" proposal is an order step to run. Like the real pump it
 * accepts every new proposal (POST /sync/push with the proposal id).
 */
void pumpPull() {
  String resp;
  const String req = String("{\"machineId\":\"") + pump.id + "\",\"sinceVersion\":" + pump.sinceVersion + "}";
  if (!pumpOk("pull", pumpPost("/pull", req, resp), resp)) return;

  String acks;
  const String now = isoTime(time(nullptr));
  int from = resp.indexOf("\"proposals\":[");
  String obj;
  while (from >= 0 && nextJsonObject(resp, from, obj)) {
    const float version = jsonNumber(obj, "version");
    if (!isnan(version) && (long)version > pump.sinceVersion) pump.sinceVersion = (long)version;
    const String type = jsonText(obj, "entityType");
    if (type == "patient") {
      const String patientId = jsonText(obj, "patientId");
      if (patientId.length() && patientId != pump.patientId) {
        pump.patientId = patientId;
        pump.patientName = jsonText(obj, "fullName");
        pumpStartBag();
        Serial.printf("[%s] on patient %s\n", pump.code, pump.patientName.c_str());
      }
    } else if (type == "infusion_step") {
      const float vol = jsonNumber(obj, "plannedVolumeMl"), rate = jsonNumber(obj, "plannedRateMlPerH");
      if (!isnan(vol) && !isnan(rate) && vol > 0 && rate > 0) {
        pump.stepId = jsonText(obj, "entityId");
        const float n = jsonNumber(obj, "stepNumber");
        pump.drug = String("Order step ") + (isnan(n) ? 1 : (int)n);
        pump.volumeMl = vol;
        pump.rateMlPerH = rate;
        pump.dispensedMl = 0;
        pump.infusedMin = 0;
        pump.finished = false;
        pump.lastAdvance = millis();
        Serial.printf("[%s] running %s: %.0f mL at %.0f mL/h\n", pump.code, pump.drug.c_str(), vol, rate);
      }
    } else {
      continue;                            // nothing to accept for other types
    }
    const String status = jsonText(obj, "status");
    if (status == "pending" || status == "delivered") {
      if (acks.length()) acks += ',';
      acks += "{\"proposalId\":\"" + jsonText(obj, "id") + "\",\"entityType\":\"" + type + "\",\"entityId\":\"" +
              jsonText(obj, "entityId") + "\",\"outcome\":\"accepted\",\"occurredAt\":\"" + now + "\"}";
    }
  }
  if (acks.length()) {
    const String body = String("{\"machineId\":\"") + pump.id + "\",\"reports\":[" + acks + "]}";
    if (pumpOk("accept", pumpPost("/push", body, resp), resp)) Serial.printf("[%s] accepted the server's proposals\n", pump.code);
  }
  if (!pump.patientId.length()) pump.lastResult = "not tagged to a patient yet (Admin -> Machine Fleet -> Assign Patient)";
}

/** The pump runs on: dispensed volume grows at the set rate; a finished bag or step rests, then the next bag starts. */
void pumpAdvance() {
  const uint32_t now = millis();
  const float dtMin = (now - pump.lastAdvance) / 60000.0f;
  pump.lastAdvance = now;
  if (pump.finished) {
    if (now - pump.finishedAt >= PUMP_REST_MS) pumpStartBag();
    return;
  }
  pump.dispensedMl += pump.rateMlPerH * dtMin / 60.0f;
  pump.infusedMin += dtMin;
  if (pump.dispensedMl >= pump.volumeMl) {
    pump.dispensedMl = pump.volumeMl;
    pump.finished = true;
    pump.finishedAt = now;
  }
}

void pumpReport() {
  pumpAdvance();
  char nums[160];
  snprintf(nums, sizeof(nums),
           "\"remainingVolumeMl\":%.1f,\"dispensedVolumeMl\":%.1f,\"flowRateMlPerH\":%.1f,\"infusedTimeMin\":%.2f,\"pauseTimeSec\":0",
           pump.volumeMl - pump.dispensedMl, pump.dispensedMl, pump.finished ? 0.0f : pump.rateMlPerH, pump.infusedMin);
  String payload = "{\"patientId\":\"" + pump.patientId + "\",\"stepId\":";
  payload += pump.stepId.length() ? "\"" + pump.stepId + "\"" : String("null");
  payload += ",\"currentMedicineName\":\"" + pump.drug + "\"," + nums;
  payload += pump.finished ? ",\"pumpState\":\"STOPPED\",\"workingMode\":\"Continuous\",\"workingStatusRaw\":\"Completed\"}"
                           : ",\"pumpState\":\"RUNNING\",\"workingMode\":\"Continuous\",\"workingStatusRaw\":\"Running\"}";
  const String body = String("{\"machineId\":\"") + pump.id + "\",\"reports\":[{\"entityType\":\"infusion_live_status\",\"entityId\":\"" +
                      pump.id + "\",\"outcome\":\"reported\",\"occurredAt\":\"" + isoTime(time(nullptr)) + "\",\"payload\":" + payload + "}]}";
  String resp;
  if (!pumpOk("status", pumpPost("/push", body, resp), resp)) return;
  if (resp.indexOf("\"status\":\"error\"") >= 0) {
    pump.lastResult = "status refused: " + jsonText(resp, "message");
    Serial.printf("[%s] %s\n", pump.code, pump.lastResult.c_str());
    return;
  }
  pump.sent++;
  char line[120];
  snprintf(line, sizeof(line), "ok: %s %.0f mL/h, %.0f of %.0f mL", pump.drug.c_str(), pump.finished ? 0.0f : pump.rateMlPerH,
           pump.dispensedMl, pump.volumeMl);
  pump.lastResult = line;
}

/** Pump work for this loop: at most one request, and never while another is due elsewhere. */
void pumpService() {
  if (!pump.enabled || pump.paused || WiFi.status() != WL_CONNECTED || !clockValid()) return;
  const uint32_t now = millis();
  if ((int32_t)(now - pump.nextTryAt) < 0) return;
  if (!pump.lastPull || now - pump.lastPull >= PUMP_PULL_MS) {
    pump.lastPull = now;
    pumpPull();
  } else if (pump.patientId.length() && now - pump.lastStatus >= PUMP_STATUS_MS) {
    pump.lastStatus = now;
    pumpReport();
  }
}

// ---------------- Status and commands ----------------
void printStatus() {
  if (WiFi.status() == WL_CONNECTED) Serial.printf("[simulator] Wi-Fi ok %d dBm", WiFi.RSSI());
  else Serial.print("[simulator] Wi-Fi connecting...");
  Serial.println(clockValid() ? " | clock ok" : " | waiting for time");
  for (size_t i = 0; i < MACHINE_COUNT; i++) {
    const Machine &m = machines[i];
    if (!m.enabled) {
      Serial.printf("  %-10s %-24s not simulated (no credentials in secrets.h)\n", m.code, m.type);
      continue;
    }
    Serial.printf("  %-10s %-24s %s sent %lu, queued %u", m.code, m.type, m.paused ? "OFF " : "",
                  (unsigned long)m.sent, (unsigned)m.qCount);
    if (m.dropped) Serial.printf(" (%lu lost offline)", (unsigned long)m.dropped);
    Serial.printf(" | last send: %s\n", m.lastResult.c_str());
  }
  if (!pump.enabled) Serial.printf("  %-10s %-24s not simulated (no credentials in secrets.h)\n", pump.code, "Infusion pump");
  else Serial.printf("  %-10s %-24s %s sent %lu | %s\n", pump.code, "Infusion pump", pump.paused ? "OFF " : "", (unsigned long)pump.sent,
                     pump.lastResult.c_str());
}

void printHelp() {
  Serial.println("Commands: help | status | off <code|all> | on <code|all>   e.g. off ECMO-001");
}

void setPaused(const char *which, bool paused) {
  bool found = false;
  for (size_t i = 0; i < MACHINE_COUNT; i++) {
    Machine &m = machines[i];
    if (!m.enabled || (strcasecmp(which, "all") != 0 && strcasecmp(which, m.code) != 0)) continue;
    m.paused = paused;
    found = true;
    Serial.printf("%s %s\n", m.code, paused ? "stopped sending" : "sending again");
  }
  if (pump.enabled && (strcasecmp(which, "all") == 0 || strcasecmp(which, pump.code) == 0)) {
    pump.paused = paused;
    found = true;
    Serial.printf("%s %s\n", pump.code, paused ? "stopped sending" : "sending again");
  }
  if (!found) Serial.printf("No simulated machine called %s\n", which);
}

void runCommand(char *c) {
  if (!strcmp(c, "help")) printHelp();
  else if (!strcmp(c, "status")) printStatus();
  else if (!strncmp(c, "off ", 4)) setPaused(c + 4, true);
  else if (!strncmp(c, "on ", 3)) setPaused(c + 3, false);
  else if (c[0]) {
    Serial.printf("Unknown: %s\n", c);
    printHelp();
  }
}

void pollSerialCommands() {
  static char buf[48];
  static size_t len = 0;
  while (Serial.available()) {
    const char ch = (char)Serial.read();
    if (ch == '\r') continue;
    if (ch == '\n') {
      buf[len] = 0;
      runCommand(buf);
      len = 0;
    } else if (len < sizeof(buf) - 1) {
      buf[len++] = ch;
    }
  }
}

// ---------------- Main ----------------
void setup() {
  Serial.begin(115200);
  delay(1500);                             // native USB: give the Serial Monitor time to attach
  Serial.println();
  Serial.printf("0dh.in machine simulator -> %s\n", SERVER_URL);
  for (size_t i = 0; i < MACHINE_COUNT; i++) {
    Machine &m = machines[i];
    m.enabled = credentialsFilled(m.id, m.token);
    m.lastResult = "nothing sent yet";
    Serial.printf("  %-10s %-24s %s\n", m.code, m.type, m.enabled ? "simulated" : "not simulated (no credentials in secrets.h)");
  }
  pump.syncUrl = SERVER_URL;
  const int ingest = pump.syncUrl.indexOf("/vigil/ingest");
  pump.enabled = credentialsFilled(pump.id, pump.token) && ingest >= 0;
  if (ingest >= 0) pump.syncUrl = pump.syncUrl.substring(0, ingest) + "/sync";
  pump.lastResult = "nothing sent yet";
  Serial.printf("  %-10s %-24s %s\n", pump.code, "Infusion pump",
                pump.enabled ? "simulated" : ingest < 0 ? "not simulated (SERVER_URL must end in /vigil/ingest)"
                                                        : "not simulated (no credentials in secrets.h)");
  printHelp();

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  configTime(0, 0, "pool.ntp.org", "time.google.com");  // UTC; messages carry +0000

  tlsClient.setCACert(ROOT_CAS);
  http.setReuse(true);                     // keep the connection open between sends
  http.setTimeout(8000);
}

void loop() {
  static time_t lastSecond = 0;
  static uint32_t lastStatus = 0;
  pollSerialCommands();
  if (clockValid()) {                      // never send without a real time
    const time_t now = time(nullptr);
    if (now != lastSecond) {
      lastSecond = now;
      tick(now);
    }
  }
  sendPending();
  pumpService();
  if (millis() - lastStatus >= STATUS_MS) {
    lastStatus = millis();
    printStatus();
  }
}
