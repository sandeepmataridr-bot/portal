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
 *   PSRAM               OPI PSRAM (recommended: room for the three HTTPS connections)
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
#include <sys/time.h>
#include <time.h>

#include "esp_sntp.h"

#include "root_cas.h"
#include "secrets.h"  // copy secrets.example.h to secrets.h

// ---------------- Settings ----------------
const size_t QUEUE_LEN = 120;          // per machine: 2 minutes of messages kept while offline (with PSRAM)
const size_t QUEUE_LEN_SMALL = 30;     // without PSRAM: 30 s
const size_t BATCH_MAX = 20;           // messages per request when catching up
const uint32_t STATUS_MS = 10000;      // status lines on the Serial Monitor
// Requests run in parallel, each sender task with its own HTTPS connection. One request to a
// hosted portal takes about 0.5-1 s (Wi-Fi, internet, Cloudflare, back to the server), so one
// connection taking the machines in turn reached each machine only every 3-5 s: the portal then
// showed "No live data" and the ECMO data-loss alarm. Three senders keep every machine near 1 s.
const int SENDERS = 3;
const uint32_t SENDER_STACK = 12288;   // bytes per sender task (TLS handshakes need room)

// ---------------- Readings ----------------
const uint8_t SETTINGS_EVERY = 10;      // settings and alarm limits: every 10 s, and at once when they change
const uint8_t ON_CHANGE = 255;         // lab results: only when a new one is entered

struct Field {
  const char *code;   // Vigil signal name, sent as "<code>^<code>^0DH"
  const char *ucum;   // unit, exactly as the server expects it
  uint8_t decimals;
  uint8_t every;      // 0: in every message (live readings); N: every N s or when it changes; ON_CHANGE
};

// ECMO console + heater unit: every clinical value of the ECMO HMI (index names keep the simulation readable)
enum { E_FLOW, E_RPM, E_PV, E_PRE, E_POST, E_DP, E_SWEEP, E_FIO2, E_TEMP, E_BUBBLE, E_LEVEL, E_SVO2,
       H_WTEMP, H_SET, H_LEVEL, H_FLOW, H_PRESS, H_GT38, H_LOW,
       E_SAO2, E_TARGET, E_SWEEP_ON, E_SWEEP_ACT, E_FIO2_MEAS, E_GAS_SRC, E_GAS_IN, E_GAS_SUP,
       E_AV_MODE, E_AV_VALVE, E_AV_DUR, E_AV_IN, E_AV_EX, H_MODE,
       L_HB, L_HCT, L_PH, L_PCO2, L_PO2, L_LACT, L_ALB, L_ACT,
       LM_FLOW_LO, LM_FLOW_HI, LM_PUMP_HI, LM_PV_LO, LM_PA_HI, LM_PIN_HI, LM_DP_HI, LM_TEMP_LO, LM_TEMP_HI,
       LM_SVO2_LO, LM_FIO2_LO, LM_GASP_LO, ECMO_N };
const Field ECMO_FIELDS[ECMO_N] = {
  {"ECMO_BLOOD_FLOW", "L/min", 2},
  {"ECMO_PUMP_SPEED", "{rpm}", 0},
  {"ECMO_P_VENOUS", "mm[Hg]", 0},
  {"ECMO_P_PRE_OXY", "mm[Hg]", 0},
  {"ECMO_P_POST_OXY", "mm[Hg]", 0},
  {"ECMO_OXY_DELTA_P", "mm[Hg]", 0},
  {"ECMO_SWEEP_FLOW", "L/min", 1, SETTINGS_EVERY},
  {"ECMO_FIO2", "%", 0, SETTINGS_EVERY},
  {"ECMO_BLOOD_TEMP", "Cel", 1},
  {"ECMO_BUBBLE_ALARM", "{flag}", 0},
  {"ECMO_LEVEL_ALARM", "{flag}", 0},
  {"ECMO_SVO2", "%", 0},
  {"HU_WATER_TEMP", "Cel", 1},
  {"HU_SET_TEMP", "Cel", 1, SETTINGS_EVERY},
  {"HU_WATER_LEVEL", "%", 1},
  {"HU_WATER_FLOW", "L/min", 2},
  {"HU_WATER_PRESSURE", "bar", 3},
  {"HU_GT38_ON", "{flag}", 0, SETTINGS_EVERY},
  {"HU_LOW_WATER", "{flag}", 0},
  {"ECMO_SAO2", "%", 0},
  {"ECMO_PUMP_TARGET", "{rpm}", 0, SETTINGS_EVERY},
  {"ECMO_SWEEP_ON", "{flag}", 0, SETTINGS_EVERY},
  {"ECMO_SWEEP_FLOW_ACTUAL", "L/min", 2},
  {"ECMO_FIO2_MEASURED", "%", 1},
  {"ECMO_GAS_SOURCE", "{code}", 0, SETTINGS_EVERY},
  {"ECMO_GAS_INLET_P", "bar", 2},
  {"ECMO_GAS_SUPPLY_P", "bar", 2},
  {"ECMO_AV_MODE", "{code}", 0, SETTINGS_EVERY},
  {"ECMO_AV_VALVE", "{code}", 0, SETTINGS_EVERY},
  {"ECMO_AV_DURATION", "s", 0, SETTINGS_EVERY},
  {"ECMO_AV_IN_FLOW", "L/min", 2},
  {"ECMO_AV_EX_FLOW", "L/min", 2},
  {"HU_MODE", "{code}", 0, SETTINGS_EVERY},
  {"LAB_HB", "g/dL", 1, ON_CHANGE},
  {"LAB_HCT", "%", 1, ON_CHANGE},
  {"LAB_PH", "[pH]", 2, ON_CHANGE},
  {"LAB_PCO2", "mm[Hg]", 1, ON_CHANGE},
  {"LAB_PO2", "mm[Hg]", 1, ON_CHANGE},
  {"LAB_LACTATE", "mmol/L", 1, ON_CHANGE},
  {"LAB_ALBUMIN", "g/dL", 1, ON_CHANGE},
  {"LAB_ACT", "s", 0, ON_CHANGE},
  {"LIMIT_FLOW_LO", "L/min", 2, SETTINGS_EVERY},
  {"LIMIT_FLOW_HI", "L/min", 2, SETTINGS_EVERY},
  {"LIMIT_PUMP_HI", "{rpm}", 0, SETTINGS_EVERY},
  {"LIMIT_PV_LO", "mm[Hg]", 1, SETTINGS_EVERY},
  {"LIMIT_PA_HI", "mm[Hg]", 1, SETTINGS_EVERY},
  {"LIMIT_PIN_HI", "mm[Hg]", 1, SETTINGS_EVERY},
  {"LIMIT_DP_HI", "mm[Hg]", 1, SETTINGS_EVERY},
  {"LIMIT_TEMP_LO", "Cel", 1, SETTINGS_EVERY},
  {"LIMIT_TEMP_HI", "Cel", 1, SETTINGS_EVERY},
  {"LIMIT_SVO2_LO", "%", 1, SETTINGS_EVERY},
  {"LIMIT_FIO2_LO", "%", 0, SETTINGS_EVERY},
  {"LIMIT_GASP_LO", "bar", 1, SETTINGS_EVERY},
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
  int64_t tMs;                // UTC milliseconds (sent to the millisecond, so the portal's "updated N s ago" is exact)
  float v[MAX_FIELDS];
};

// ---------------- The machine's own alarms and logs (ECMO/EBOO HMI) ----------------
// Sent to POST /vigil/events. One-way, like everything here: the portal stores and shows them
// and never acknowledges, silences or changes anything on the machine.
enum { LOG_TREATMENT, LOG_ALARM, LOG_SYSTEM };
const size_t LOG_CAP = 48;             // entries waiting to be delivered (kept until the server has them)
const size_t EVENTS_LOG_MAX = 20;      // entries per request
const uint32_t EVENTS_MS = 10000;      // active alarms re-sent at least this often

struct LogItem {
  uint32_t no;
  int64_t atMs;
  uint8_t kind;               // LOG_TREATMENT / LOG_ALARM / LOG_SYSTEM
  char event[48];
  char value[24];
  char details[32];           // system: details; alarm: the limit
  char category[16];          // system log
  char result[16];            // system: result; alarm: Active / Cleared
  uint8_t priority;           // alarm: 1 low, 2 medium, 3 high
  uint16_t code;              // alarm code
};

struct ActiveAlarm {
  uint16_t code;
  const char *text;
  uint8_t priority;
  bool acknowledged;
  int64_t sinceMs;
};

struct Events {
  LogItem log[LOG_CAP];
  size_t head, count;
  uint32_t logNo;
  ActiveAlarm alarms[4];
  size_t alarmCount;
  bool dirty;                 // something new to report
  bool busy;                  // a sender is sending them right now
  uint32_t nextAt, retryAt, sent, lost;
  String lastResult;
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
  float lastSent[MAX_FIELDS]; // what was last sent of each value (fields not sent every second)
  uint32_t ticks;
  Snapshot *queue;            // qCap messages, in PSRAM when the board has it (see bigBuffer)
  size_t qCap, qHead, qCount;
  uint32_t messageNo, sent, dropped, nextSendAt, lastOkAt;
  bool busy;                  // a sender is sending for it right now
  String lastResult;
  Events *events;             // ECMO and EBOO: the machine's own alarms and logs
};

/** One sender task's own connection (see SENDERS). */
struct Sender {
  WiFiClientSecure tls;
  WiFiClient plain;
  HTTPClient http;
  Snapshot *batch;            // BATCH_MAX messages being sent
};

/** The machines' queues, results and the pump's state are shared by loop() and the sender tasks: they change only under this lock. */
SemaphoreHandle_t stateLock;
SemaphoreHandle_t handshakeLock;      // one TLS handshake at a time

/**
 * Large buffers (the offline queues, about 50 KB) go to PSRAM when the board has it (N16R8: Tools > PSRAM
 * "OPI PSRAM"), leaving the chip's own memory to Wi-Fi and the TLS connections; without PSRAM they use it.
 */
void *bigBuffer(size_t bytes) {
  void *p = psramFound() ? heap_caps_malloc(bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT) : nullptr;
  return p ? p : malloc(bytes);
}
struct Locked {
  Locked() { xSemaphoreTake(stateLock, portMAX_DELAY); }
  ~Locked() { xSemaphoreGive(stateLock); }
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

int64_t nowMs() {
  struct timeval tv;
  gettimeofday(&tv, nullptr);
  return (int64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000;
}

void copyText(char *dst, size_t size, const char *src) {
  strncpy(dst, src ? src : "", size - 1);
  dst[size - 1] = 0;
}

/** One entry of the machine's own log, kept until the server has it (the oldest gives way when full). */
void addLog(Machine &m, uint8_t kind, const char *event, const char *value = "", const char *details = "",
            const char *category = "", const char *result = "", uint8_t priority = 0, uint16_t code = 0, int64_t atMs = 0) {
  Events *ev = m.events;
  if (!ev) return;
  Locked lock;
  if (ev->count == LOG_CAP) {
    ev->head = (ev->head + 1) % LOG_CAP;
    ev->count--;
    ev->lost++;
  }
  LogItem &e = ev->log[(ev->head + ev->count) % LOG_CAP];
  e.no = ++ev->logNo;
  e.atMs = atMs ? atMs : nowMs();
  e.kind = kind;
  copyText(e.event, sizeof(e.event), event);
  copyText(e.value, sizeof(e.value), value);
  copyText(e.details, sizeof(e.details), details);
  copyText(e.category, sizeof(e.category), category);
  copyText(e.result, sizeof(e.result), result);
  e.priority = priority;
  e.code = code;
  ev->count++;
  ev->dirty = true;
}

/** A setting changed on the machine: a treatment log entry, as the HMI writes one. */
void logSetting(Machine &m, const char *event, float value, const char *unit, int decimals) {
  char text[24];
  snprintf(text, sizeof(text), "%.*f %s", decimals, value, unit);
  addLog(m, LOG_TREATMENT, event, text);
}

// Ranges: inside the ECMO HMI's default alarm limits (flow 1.00-6.00 L/min, pump < 5000 rpm,
// Pv > -100, Pa < 300, Pin < 350, dP < 50 mmHg, temperature 35.0-38.5 C, SvO2 > 60 %, gas > 2.5 bar).
// Every 30 minutes the machine asks for a blood gas sample (alarm 901, as the HMI's reminder does);
// 3 minutes later the results are entered (labs) and the alarm clears.
const uint32_t LAB_EVERY_MS = 30UL * 60 * 1000;
const uint32_t LAB_TAKES_MS = 3UL * 60 * 1000;

void enterLabs(Machine &m) {
  float *v = m.v;
  v[L_HB] = roundf(rnd(10.5f, 13.5f) * 10) / 10;
  v[L_HCT] = roundf(v[L_HB] * 3.0f * 10) / 10;
  v[L_PH] = roundf(rnd(7.36f, 7.44f) * 100) / 100;
  v[L_PCO2] = roundf(rnd(36, 44) * 10) / 10;
  v[L_PO2] = roundf(rnd(180, 320) * 10) / 10;
  v[L_LACT] = roundf(rnd(0.8f, 1.9f) * 10) / 10;
  v[L_ALB] = roundf(rnd(3.2f, 4.4f) * 10) / 10;
  v[L_ACT] = roundf(rnd(160, 200));
  char text[24];
  snprintf(text, sizeof(text), "Hb %.1f pH %.2f", v[L_HB], v[L_PH]);
  addLog(m, LOG_TREATMENT, "Lab values entered", text);
}

void simulateEcmo(Machine &m) {
  float *v = m.v;
  static Walk rpmDev(-60, 60, 12, 0.08f, 2), lpk(1.20f, 1.32f, 0.004f, 0.1f, 0.0005f);
  static Walk pv(-55, -20, 1.5f, 0.1f, 0.2f), post(165, 225, 2.0f, 0.1f, 0.3f);
  static Walk dp(15, 22, 0.8f, 0.2f, 0);                       // no drift: no oxygenator dP trend
  static Walk temp(36.4f, 37.2f, 0.06f, 0.05f, 0.002f), svo2(67, 80, 0.6f, 0.05f, 0.05f), sao2(96, 100, 0.4f, 0.1f, 0.02f);
  static Walk huLevel(72, 94, 0.15f, 0.02f, 0.05f), huFlow(2.1f, 2.9f, 0.03f, 0.1f, 0.002f);
  static Walk gasIn(3.0f, 3.4f, 0.02f, 0.1f, 0.002f), gasSup(4.2f, 4.7f, 0.02f, 0.1f, 0.002f);
  static const float TARGET[] = {3000, 3100, 3200, 3300, 3400};
  static const float SWEEP[] = {2.5f, 3.0f, 3.5f};
  static const float FIO2[] = {60, 70, 80, 90, 100};
  static const float HU_SET[] = {36.5f, 37.0f, 37.5f};
  static Setting target = {TARGET, 5, 2, 0}, sweep = {SWEEP, 3, 1, 0}, fio2 = {FIO2, 5, 4, 0}, huSet = {HU_SET, 3, 1, 0};
  static float huTemp = 0;
  static bool started = false;
  static uint32_t sampleDueAt = 0;
  static bool sampleAsked = false;

  if (!started) {                          // power-on: what the HMI logs at start-up, then the first labs
    started = true;
    addLog(m, LOG_SYSTEM, "System powered ON", "", "Controller startup", "System", "Completed");
    addLog(m, LOG_SYSTEM, "Self-test", "", "Simulated sensors", "Diagnostic", "Passed");
    addLog(m, LOG_SYSTEM, "HMI connected", "", "UART1 / 115200 baud", "Communication", "Connected");
    addLog(m, LOG_TREATMENT, "ECMO mode selected", "Pump stopped");
    logSetting(m, "Pump started", target.value(), "RPM", 0);
    enterLabs(m);
    sampleDueAt = millis() + LAB_EVERY_MS;
  }

  const float prevTarget = v[E_TARGET], prevSweep = v[E_SWEEP], prevFio2 = v[E_FIO2], prevHuSet = v[H_SET];
  v[E_TARGET] = target.value();
  v[E_RPM] = v[E_TARGET] + rpmDev.step();
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
  v[E_SAO2] = sao2.step();

  v[E_SWEEP_ON] = 1;
  v[E_SWEEP_ACT] = v[E_SWEEP] + rnd(-0.06f, 0.06f);
  v[E_FIO2_MEAS] = v[E_FIO2] + rnd(-0.6f, 0.6f);
  v[E_GAS_SRC] = 2;                        // O2 + air
  v[E_GAS_IN] = gasIn.step();
  v[E_GAS_SUP] = gasSup.step();
  v[E_AV_MODE] = 0;                        // manual
  v[E_AV_VALVE] = 0;                       // closed
  v[E_AV_DUR] = 10;
  v[E_AV_IN] = v[E_SWEEP_ACT];
  v[E_AV_EX] = v[E_SWEEP_ACT] * 0.97f + rnd(-0.02f, 0.02f);

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
  v[H_MODE] = 2;                           // run

  // the machine's alarm limits: the HMI's defaults
  v[LM_FLOW_LO] = 1.00f; v[LM_FLOW_HI] = 6.00f; v[LM_PUMP_HI] = 5000; v[LM_PV_LO] = -100.0f;
  v[LM_PA_HI] = 300.0f; v[LM_PIN_HI] = 350.0f; v[LM_DP_HI] = 50.0f; v[LM_TEMP_LO] = 35.0f; v[LM_TEMP_HI] = 38.5f;
  v[LM_SVO2_LO] = 60.0f; v[LM_FIO2_LO] = 21; v[LM_GASP_LO] = 2.5f;

  // settings changed on the machine: treatment log entries
  if (!isnan(prevTarget) && prevTarget != v[E_TARGET]) logSetting(m, "Pump speed set", v[E_TARGET], "RPM", 0);
  if (!isnan(prevSweep) && prevSweep != v[E_SWEEP]) logSetting(m, "Sweep gas flow set", v[E_SWEEP], "L/min", 1);
  if (!isnan(prevFio2) && prevFio2 != v[E_FIO2]) logSetting(m, "FiO2 set", v[E_FIO2], "%", 0);
  if (!isnan(prevHuSet) && prevHuSet != set) logSetting(m, "Heater set point", set, "C", 1);

  // blood gas sample: alarm 901, then the results are entered and the alarm clears
  Events *ev = m.events;
  if (ev && !sampleAsked && (int32_t)(millis() - sampleDueAt) >= 0) {
    sampleAsked = true;
    const int64_t since = nowMs();
    {
      Locked lock;
      ev->alarms[0] = {901, "BLOOD GAS SAMPLE DUE", 1, false, since};
      ev->alarmCount = 1;
      ev->dirty = true;
    }
    addLog(m, LOG_ALARM, "BLOOD GAS SAMPLE DUE", "---", "---", "", "Active", 1, 901, since);
  } else if (ev && sampleAsked && (int32_t)(millis() - sampleDueAt) >= (int32_t)LAB_TAKES_MS) {
    sampleAsked = false;
    int64_t since;
    {
      Locked lock;
      since = ev->alarms[0].sinceMs;
      ev->alarmCount = 0;
      ev->dirty = true;
    }
    enterLabs(m);
    addLog(m, LOG_ALARM, "BLOOD GAS SAMPLE DUE", "---", "---", "", "Cleared", 1, 901, since);
    sampleDueAt += LAB_EVERY_MS;
  }
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
    case K_ECMO: simulateEcmo(m); break;
    case K_EBOO: simulateEboo(m.v); break;
    case K_SPO2: simulateSpo2(m.v); break;
    case K_TEMP: simulateTemp(m.v); break;
    case K_MULTI: simulateMulti(m.v); break;
  }
}

// ---------------- Message queues (one per machine) ----------------
/**
 * Queues this second's message. Live readings go in every message; settings and alarm limits every
 * SETTINGS_EVERY seconds and whenever they change; lab results only when new ones are entered.
 * A value left out is NAN and gets no OBX.
 */
void enqueue(Machine &m, int64_t tMs) {
  if (m.qCount == m.qCap) {                // full: the oldest message gives way
    m.qHead = (m.qHead + 1) % m.qCap;
    m.qCount--;
    m.dropped++;
  }
  Snapshot &s = m.queue[(m.qHead + m.qCount) % m.qCap];
  s.no = ++m.messageNo;
  s.tMs = tMs;
  memcpy(s.v, m.v, sizeof(s.v));
  for (size_t i = 0; i < m.count; i++) {
    const uint8_t every = m.fields[i].every;
    if (!every) continue;
    const bool changed = !(m.v[i] == m.lastSent[i]);        // also true the first time (lastSent is NAN)
    const bool due = every != ON_CHANGE && m.ticks % every == 0;
    if (changed || due) m.lastSent[i] = m.v[i];
    else s.v[i] = NAN;
  }
  m.ticks++;
  m.qCount++;
}

/** Removes the messages up to and including number lastNo (the queue may have moved on while they were being sent). */
void dropUpTo(Machine &m, uint32_t lastNo) {
  while (m.qCount && m.queue[m.qHead].no <= lastNo) {
    m.qHead = (m.qHead + 1) % m.qCap;
    m.qCount--;
  }
}

bool clockValid() { return time(nullptr) > 1700000000; }

/** Once per clock second: every running machine takes its readings. */
void tick(int64_t tMs) {
  for (size_t i = 0; i < MACHINE_COUNT; i++) {
    Machine &m = machines[i];
    if (!m.enabled) continue;
    simulate(m);                           // keeps moving while paused, so "on" resumes naturally
    if (m.paused) continue;
    Locked lock;
    enqueue(m, tMs);
  }
}

// ---------------- HL7 PCD-01 ORU^R01 ----------------
/** HL7 TS to the millisecond, UTC: 20261027083513.250+0000 */
String hl7Time(int64_t ms) {
  const time_t t = (time_t)(ms / 1000);
  struct tm tm;
  gmtime_r(&t, &tm);
  char buf[32];
  const size_t n = strftime(buf, sizeof(buf), "%Y%m%d%H%M%S", &tm);
  snprintf(buf + n, sizeof(buf) - n, ".%03d+0000", (int)(ms % 1000));
  return String(buf);
}

void appendObx(String &out, int &setId, const Field &f, float v, const String &ts) {
  if (isnan(v)) return;                    // not in this message (see enqueue)
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
  const String ts = hl7Time(s.tMs);
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

// ---------------- Sending (SENDERS tasks in parallel) ----------------
const bool useHttps = strncmp(SERVER_URL, "https://", 8) == 0;
Sender senders[SENDERS];

// ---------------- Clock check ----------------
// The portal shows how old each reading is by comparing the reading's time (this board's clock)
// with its own clock, so the two must agree. Both follow internet time (NTP); this checks it.
// Every response carries the server side's time ("Date" header, whole seconds), so the
// difference is known to about 1 s; a difference of 2 s or more is reported.
volatile int32_t clockDiffS = 0;           // server minus this board, seconds
volatile bool clockDiffKnown = false;

/** "Tue, 27 Oct 2026 03:08:12 GMT" -> seconds since 1970 (UTC), or -1. */
int64_t parseHttpDate(const String &text) {
  static const char *MONTHS = "JanFebMarAprMayJunJulAugSepOctNovDec";
  char mon[4] = {0};
  int d, y, h, mi, sec;
  if (sscanf(text.c_str(), "%*3s, %d %3s %d %d:%d:%d", &d, mon, &y, &h, &mi, &sec) != 6) return -1;
  const char *at = strstr(MONTHS, mon);
  if (!at) return -1;
  struct tm tm = {};
  tm.tm_year = y - 1900;
  tm.tm_mon = (at - MONTHS) / 3;
  tm.tm_mday = d;
  tm.tm_hour = h;
  tm.tm_min = mi;
  tm.tm_sec = sec;
  return (int64_t)mktime(&tm);             // the board runs on UTC (configTime(0, 0, ...))
}

void noteServerClock(const String &date) {
  const int64_t server = parseHttpDate(date);
  if (server < 0 || !clockValid()) return;
  clockDiffS = (int32_t)(server - (int64_t)time(nullptr));
  clockDiffKnown = true;
}

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

/** POST as one machine on this sender's connection; returns the HTTP code and the response body. */
int post(Sender &s, const String &url, const char *id, const char *token, const String &body, String &resp) {
  const bool begun = useHttps ? s.http.begin(s.tls, url) : s.http.begin(s.plain, url);
  if (!begun) {
    resp = "bad SERVER_URL";
    return -1;
  }
  s.http.addHeader("Content-Type", "application/json");
  s.http.addHeader("X-Machine-Id", id);
  s.http.addHeader("X-Machine-Token", token);
  // Opening a connection (the TLS handshake) needs the most memory: one sender at a time does it.
  const bool opening = useHttps ? !s.tls.connected() : !s.plain.connected();
  if (opening) xSemaphoreTake(handshakeLock, portMAX_DELAY);
  const int code = s.http.POST(body);
  resp = code > 0 ? s.http.getString() : s.http.errorToString(code);
  if (opening) xSemaphoreGive(handshakeLock);
  if (code > 0) noteServerClock(s.http.header("Date"));
  s.http.end();
  return code;
}

/** Sends the oldest queued messages of one machine (up to BATCH_MAX). The queue stays shared: copied under the lock, sent without it. */
void sendFor(Machine &m, Sender &s) {
  Snapshot *batch = s.batch;
  size_t n;
  {
    Locked lock;
    n = m.qCount < BATCH_MAX ? m.qCount : BATCH_MAX;
    for (size_t i = 0; i < n; i++) batch[i] = m.queue[(m.qHead + i) % m.qCap];
  }
  if (!n) return;
  String body;
  body.reserve(n * 1900 + 48);
  body += "{\"driver\":\"hl7_pcd01\",\"frames\":[";
  for (size_t i = 0; i < n; i++) {
    if (i) body += ',';
    appendJsonString(body, buildFrame(m, batch[i]));
  }
  body += "]}";

  String resp;
  const int code = post(s, SERVER_URL, m.id, m.token, body, resp);
  const uint32_t now = millis();
  Locked lock;
  if (code >= 200 && code < 300) {
    const int rejected = jsonInt(resp, "\"rejected\":");
    dropUpTo(m, batch[n - 1].no);
    m.sent += n;
    m.lastOkAt = now;
    m.lastResult = String(code) + ", accepted " + jsonInt(resp, "\"accepted\":") + " of " + n;
    if (rejected > 0) Serial.printf("[%s] server rejected %d message(s): %s\n", m.code, rejected, firstRejection(resp).c_str());
    m.nextSendAt = now;
  } else if (code == 401) {
    m.lastResult = "401: machine ID or token not accepted; check secrets.h";
    m.nextSendAt = now + 30000;
  } else if (code == 400) {
    m.lastResult = "400: request refused as malformed (messages dropped): " + resp.substring(0, 160);
    dropUpTo(m, batch[n - 1].no);          // retrying the same messages can never succeed
    m.nextSendAt = now + 5000;
  } else if (code == 403 || code == 404) {
    // 403: the portal is in TEST mode, or the machine is registered as a type that does not send monitoring data
    m.lastResult = String(code) + ": " + resp.substring(0, 160);
    m.nextSendAt = now + 30000;
  } else if (code == 429) {
    m.lastResult = "429: too many requests, slowing down";
    m.nextSendAt = now + 10000;
  } else {
    m.lastResult = String(code) + ": " + resp.substring(0, 120);  // network or server error: keep and retry
    m.nextSendAt = now + 5000;
  }
  if (code < 200 || code >= 300) Serial.printf("[%s] %s\n", m.code, m.lastResult.c_str());
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
  bool busy;                               // a sender is working for the pump right now
  bool hasPatient;                         // read by the scheduler (patientId itself belongs to the pump's sender)
  String lastResult;                       // under the lock
} pump = {PUMP_CODE, PUMP_ID, PUMP_TOKEN};

void setPumpResult(const String &text) {
  Locked lock;
  pump.lastResult = text;
}

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

/** POST to /sync/<path> as the pump, on this sender's connection. */
int pumpPost(Sender &s, const char *path, const String &body, String &resp) {
  return post(s, pump.syncUrl + path, pump.id, pump.token, body, resp);
}

/** Records a failed request; true when the code means success. */
bool pumpOk(const char *what, int code, const String &resp) {
  if (code >= 200 && code < 300) return true;
  const String text = code == 401 ? String(what) + " 401: machine ID or token not accepted; check secrets.h"
                                  : String(what) + " " + code + ": " + resp.substring(0, 120);
  setPumpResult(text);
  pump.nextTryAt = millis() + (code == 401 || code == 403 ? 30000 : 5000);
  Serial.printf("[%s] %s\n", pump.code, text.c_str());
  return false;
}

/**
 * Pull: the newest "patient" proposal is the patient this pump is on; an
 * "infusion_step" proposal is an order step to run. Like the real pump it
 * accepts every new proposal (POST /sync/push with the proposal id).
 */
void pumpPull(Sender &s) {
  String resp;
  const String req = String("{\"machineId\":\"") + pump.id + "\",\"sinceVersion\":" + pump.sinceVersion + "}";
  if (!pumpOk("pull", pumpPost(s, "/pull", req, resp), resp)) return;

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
        pump.hasPatient = true;
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
    if (pumpOk("accept", pumpPost(s, "/push", body, resp), resp)) Serial.printf("[%s] accepted the server's proposals\n", pump.code);
  }
  if (!pump.patientId.length()) setPumpResult("not tagged to a patient yet (Admin -> Machine Fleet -> Assign Patient)");
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

void pumpReport(Sender &s) {
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
  if (!pumpOk("status", pumpPost(s, "/push", body, resp), resp)) return;
  if (resp.indexOf("\"status\":\"error\"") >= 0) {
    const String text = "status refused: " + jsonText(resp, "message");
    setPumpResult(text);
    Serial.printf("[%s] %s\n", pump.code, text.c_str());
    return;
  }
  char line[120];
  snprintf(line, sizeof(line), "ok: %s %.0f mL/h, %.0f of %.0f mL", pump.drug.c_str(), pump.finished ? 0.0f : pump.rateMlPerH,
           pump.dispensedMl, pump.volumeMl);
  Locked lock;
  pump.sent++;
  pump.lastResult = line;
}

/** The pump's next request (a sender has claimed the pump): pull if due, else the live status. */
void runPumpJob(Sender &s) {
  const uint32_t now = millis();
  if (!pump.lastPull || now - pump.lastPull >= PUMP_PULL_MS) {
    pump.lastPull = now;
    pumpPull(s);
  } else {
    pump.lastStatus = now;
    pumpReport(s);
  }
}

// ---------------- The machine's alarms and logs, sent ----------------
String eventsUrl;                          // SERVER_URL with /ingest replaced by /events

String isoMs(int64_t ms) {
  const time_t t = (time_t)(ms / 1000);
  struct tm tm;
  gmtime_r(&t, &tm);
  char buf[32];
  const size_t n = strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%S", &tm);
  snprintf(buf + n, sizeof(buf) - n, ".%03dZ", (int)(ms % 1000));
  return String(buf);
}

void jsonField(String &out, const char *key, const char *value) {
  if (!value || !*value) return;
  out += ",\"";
  out += key;
  out += "\":";
  appendJsonString(out, String(value));
}

/** The active alarms (always, [] when none) and up to EVENTS_LOG_MAX waiting log entries; entries go once the server has them. */
void sendEvents(Machine &m, Sender &s) {
  static LogItem copies[SENDERS][EVENTS_LOG_MAX];
  LogItem *batch = copies[&s - senders];
  Events &ev = *m.events;
  ActiveAlarm alarms[4];
  size_t na, n;
  {
    Locked lock;
    na = ev.alarmCount;
    memcpy(alarms, ev.alarms, sizeof(alarms));
    n = ev.count < EVENTS_LOG_MAX ? ev.count : EVENTS_LOG_MAX;
    for (size_t i = 0; i < n; i++) batch[i] = ev.log[(ev.head + i) % LOG_CAP];
    ev.dirty = false;
  }
  static const char *KIND[] = {"treatment", "alarm", "system"};
  String body = "{\"alarms\":[";
  for (size_t i = 0; i < na; i++) {
    if (i) body += ',';
    body += "{\"code\":" + String(alarms[i].code) + ",\"text\":";
    appendJsonString(body, String(alarms[i].text));
    body += ",\"priority\":" + String(alarms[i].priority) + ",\"acknowledged\":" + (alarms[i].acknowledged ? "true" : "false");
    body += ",\"since\":\"" + isoMs(alarms[i].sinceMs) + "\"}";
  }
  body += "],\"silencedUntil\":null";
  if (n) {
    body += ",\"log\":[";
    for (size_t i = 0; i < n; i++) {
      const LogItem &e = batch[i];
      if (i) body += ',';
      body += String("{\"kind\":\"") + KIND[e.kind] + "\",\"at\":\"" + isoMs(e.atMs) + "\"";
      jsonField(body, "event", e.event);
      jsonField(body, "value", e.value);
      jsonField(body, "details", e.details);
      jsonField(body, "category", e.category);
      jsonField(body, "result", e.result);
      if (e.kind == LOG_ALARM) body += ",\"priority\":" + String(e.priority ? e.priority : 1) + ",\"code\":" + String(e.code);
      body += '}';
    }
    body += ']';
  }
  body += '}';

  String resp;
  const int code = post(s, eventsUrl, m.id, m.token, body, resp);
  const uint32_t now = millis();
  Locked lock;
  if (code >= 200 && code < 300) {
    const uint32_t lastNo = n ? batch[n - 1].no : 0;
    while (ev.count && ev.log[ev.head].no <= lastNo) {
      ev.head = (ev.head + 1) % LOG_CAP;
      ev.count--;
    }
    ev.sent += n;
    ev.lastResult = String(code) + ", " + na + " alarm(s), " + n + " log entries";
    ev.nextAt = now + EVENTS_MS;
    if (ev.count) ev.dirty = true;         // more entries waiting
  } else {
    ev.lastResult = code == 401 ? String("401: machine ID or token not accepted; check secrets.h") : String(code) + ": " + resp.substring(0, 120);
    ev.dirty = true;
    ev.retryAt = now + (code == 401 || code == 403 ? 30000 : 5000);
    Serial.printf("[%s alarms/logs] %s\n", m.code, ev.lastResult.c_str());
  }
}

// ---------------- Sender tasks ----------------
const int PUMP_JOB = -2;
const int EVENTS_JOB = 100;                // + machine index: that machine's alarms and logs

/**
 * The next piece of work for a free sender: the pump when its pull or status is due (a few
 * requests a minute), a machine's alarms and logs when there is something new (or every
 * EVENTS_MS), else the machine whose oldest unsent reading has waited longest. Claimed work is
 * marked busy, so two senders never send for the same thing at once.
 */
int claimJob() {
  Locked lock;
  const uint32_t now = millis();
  if (pump.enabled && !pump.paused && !pump.busy && (int32_t)(now - pump.nextTryAt) >= 0 &&
      (!pump.lastPull || now - pump.lastPull >= PUMP_PULL_MS || (pump.hasPatient && now - pump.lastStatus >= PUMP_STATUS_MS))) {
    pump.busy = true;
    return PUMP_JOB;
  }
  for (size_t i = 0; i < MACHINE_COUNT; i++) {
    Events *ev = machines[i].events;
    if (!machines[i].enabled || machines[i].paused || !ev || ev->busy || (int32_t)(now - ev->retryAt) < 0) continue;
    if (!ev->dirty && (int32_t)(now - ev->nextAt) < 0) continue;
    ev->busy = true;
    return EVENTS_JOB + (int)i;
  }
  int best = -1;
  int64_t oldest = 0;
  for (size_t i = 0; i < MACHINE_COUNT; i++) {
    const Machine &m = machines[i];
    if (!m.enabled || m.busy || !m.qCount || (int32_t)(now - m.nextSendAt) < 0) continue;
    const int64_t waiting = m.queue[m.qHead].tMs;
    if (best < 0 || waiting < oldest) {
      best = (int)i;
      oldest = waiting;
    }
  }
  if (best >= 0) machines[best].busy = true;
  return best;
}

void releaseJob(int job) {
  Locked lock;
  if (job == PUMP_JOB) pump.busy = false;
  else if (job >= EVENTS_JOB) machines[job - EVENTS_JOB].events->busy = false;
  else machines[job].busy = false;
}

void senderTask(void *arg) {
  Sender &s = *static_cast<Sender *>(arg);
  s.tls.setCACert(ROOT_CAS);
  s.http.setReuse(true);                   // keep this sender's connection open between requests
  s.http.setTimeout(8000);
  const char *keys[] = {"Date"};
  s.http.collectHeaders(keys, 1);          // the server's clock, for the clock check in the status line
  for (;;) {
    const int job = (WiFi.status() == WL_CONNECTED && clockValid()) ? claimJob() : -1;
    if (job == -1) {
      vTaskDelay(pdMS_TO_TICKS(20));
      continue;
    }
    if (job == PUMP_JOB) runPumpJob(s);
    else if (job >= EVENTS_JOB) sendEvents(machines[job - EVENTS_JOB], s);
    else sendFor(machines[job], s);
    releaseJob(job);
  }
}

// ---------------- Status and commands ----------------
void printStatus() {
  if (WiFi.status() == WL_CONNECTED) Serial.printf("[simulator] Wi-Fi ok %d dBm", WiFi.RSSI());
  else Serial.print("[simulator] Wi-Fi connecting...");
  if (!clockValid()) Serial.print(" | waiting for time");
  else if (!clockDiffKnown) Serial.print(" | clock ok (server not heard yet)");
  else if (abs(clockDiffS) >= 2) Serial.printf(" | CLOCK OFF: this board is %ld s %s the server", (long)abs(clockDiffS), clockDiffS > 0 ? "behind" : "ahead of");
  else Serial.print(" | clock matches the server");
  Serial.printf(" | %d senders | free memory %u KB%s\n", SENDERS, (unsigned)(ESP.getFreeHeap() / 1024), psramFound() ? " (PSRAM on)" : "");
  const uint32_t now = millis();
  Locked lock;
  for (size_t i = 0; i < MACHINE_COUNT; i++) {
    const Machine &m = machines[i];
    if (!m.enabled) {
      Serial.printf("  %-10s %-24s not simulated (no credentials in secrets.h)\n", m.code, m.type);
      continue;
    }
    Serial.printf("  %-10s %-24s %s sent %lu, queued %u", m.code, m.type, m.paused ? "OFF " : "",
                  (unsigned long)m.sent, (unsigned)m.qCount);
    if (m.dropped) Serial.printf(" (%lu lost offline)", (unsigned long)m.dropped);
    if (m.lastOkAt) Serial.printf(", last delivered %.1f s ago", (now - m.lastOkAt) / 1000.0f);
    Serial.printf(" | last send: %s\n", m.lastResult.c_str());
  }
  if (!pump.enabled) Serial.printf("  %-10s %-24s not simulated (no credentials in secrets.h)\n", pump.code, "Infusion pump");
  else Serial.printf("  %-10s %-24s %s sent %lu | %s\n", pump.code, "Infusion pump", pump.paused ? "OFF " : "", (unsigned long)pump.sent,
                     pump.lastResult.c_str());
  for (size_t i = 0; i < MACHINE_COUNT; i++) {
    const Machine &m = machines[i];
    if (!m.enabled || !m.events || m.kind != K_ECMO) continue;
    const Events &ev = *m.events;
    Serial.printf("  %-10s alarms and logs: %u active alarm(s), %lu log entries sent, %u waiting", m.code, (unsigned)ev.alarmCount,
                  (unsigned long)ev.sent, (unsigned)ev.count);
    if (ev.lost) Serial.printf(" (%lu lost: log full while offline)", (unsigned long)ev.lost);
    Serial.printf(" | %s\n", ev.lastResult.length() ? ev.lastResult.c_str() : "nothing sent yet");
  }
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
    if (m.enabled) {
      m.qCap = psramFound() ? QUEUE_LEN : QUEUE_LEN_SMALL;
      m.queue = static_cast<Snapshot *>(bigBuffer(m.qCap * sizeof(Snapshot)));
      if (!m.queue) {
        m.enabled = false;
        Serial.printf("  %s: not enough memory for its queue\n", m.code);
      }
      for (size_t f = 0; f < MAX_FIELDS; f++) m.v[f] = m.lastSent[f] = NAN;
      if (m.kind == K_ECMO || m.kind == K_EBOO) m.events = new Events();
    }
    m.lastResult = "nothing sent yet";
    Serial.printf("  %-10s %-24s %s\n", m.code, m.type, m.enabled ? "simulated" : "not simulated (no credentials in secrets.h)");
  }
  pump.syncUrl = SERVER_URL;
  const int ingest = pump.syncUrl.indexOf("/vigil/ingest");
  pump.enabled = credentialsFilled(pump.id, pump.token) && ingest >= 0;
  if (ingest >= 0) pump.syncUrl = pump.syncUrl.substring(0, ingest) + "/sync";
  eventsUrl = String(SERVER_URL);
  eventsUrl.replace("/vigil/ingest", "/vigil/events");
  pump.lastResult = "nothing sent yet";
  Serial.printf("  %-10s %-24s %s\n", pump.code, "Infusion pump",
                pump.enabled ? "simulated" : ingest < 0 ? "not simulated (SERVER_URL must end in /vigil/ingest)"
                                                        : "not simulated (no credentials in secrets.h)");
  printHelp();

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  // Internet time, UTC (messages carry +0000), checked again every 15 min instead of the default hour,
  // so the board's clock keeps agreeing with the server's (see the clock check).
  sntp_set_sync_interval(15 * 60 * 1000UL);
  configTime(0, 0, "pool.ntp.org", "time.google.com");

  stateLock = xSemaphoreCreateMutex();
  handshakeLock = xSemaphoreCreateMutex();
  for (int i = 0; i < SENDERS; i++) {
    senders[i].batch = static_cast<Snapshot *>(bigBuffer(BATCH_MAX * sizeof(Snapshot)));
    char name[12];
    snprintf(name, sizeof(name), "sender%d", i + 1);
    xTaskCreatePinnedToCore(senderTask, name, SENDER_STACK, &senders[i], 1, nullptr, 1);
  }
}

void loop() {
  static time_t lastSecond = 0;
  static uint32_t lastStatus = 0;
  pollSerialCommands();
  if (clockValid()) {                      // never send without a real time
    struct timeval tv;
    gettimeofday(&tv, nullptr);
    if (tv.tv_sec != lastSecond) {         // once per clock second, stamped to the millisecond
      lastSecond = tv.tv_sec;
      tick((int64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000);
    }
  }
  delay(5);                                // the senders run in their own tasks
  if (millis() - lastStatus >= STATUS_MS) {
    lastStatus = millis();
    printStatus();
  }
}
