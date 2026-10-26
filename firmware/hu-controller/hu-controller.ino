// Heater-unit controller (Arduino Uno/Nano, ST7565 display).
// The display code is the original test sketch, unchanged. Added for the
// ESP32 gateway: Serial.begin(115200) in setup() and sendTelemetry(), which
// prints one "$HU,...*XX" line per second on TX (pin 1) -> 1k/2k divider ->
// gateway GPIO 16. Line format: firmware/PROTOCOL.md.
#include <Arduino.h>
#include <U8g2lib.h>
#include <SPI.h>

#define PIN_CS      10
#define PIN_A0      9
#define PIN_RST     8
#define COL_OFFSET  1
#define START_LINE  32
#define PRESS_MAX   0.35   // bar, full scale of pressure bar (TL-B04 max head ~0.34 bar)

U8G2_ST7565_ERC12864_F_4W_HW_SPI u8g2(U8G2_R0, PIN_CS, PIN_A0, PIN_RST);

// ---------------- Display fix (faster version) ----------------
void lcdCmd(uint8_t c) {
  SPI.beginTransaction(SPISettings(4000000, MSBFIRST, SPI_MODE0));
  digitalWrite(PIN_A0, LOW);
  digitalWrite(PIN_CS, LOW);
  SPI.transfer(c);
  digitalWrite(PIN_CS, HIGH);
  SPI.endTransaction();
}

void clearFullRam() {
  SPI.beginTransaction(SPISettings(4000000, MSBFIRST, SPI_MODE0));
  digitalWrite(PIN_CS, LOW);
  for (uint8_t p = 0; p < 8; p++) {
    digitalWrite(PIN_A0, LOW);
    SPI.transfer(0xB0 | p); SPI.transfer(0x10); SPI.transfer(0x00);
    digitalWrite(PIN_A0, HIGH);
    for (uint8_t x = 0; x < 132; x++) SPI.transfer(0x00);
  }
  digitalWrite(PIN_CS, HIGH);
  SPI.endTransaction();
}

void sendBufferFixed() {
  uint8_t *buf = u8g2.getBufferPtr();
  SPI.beginTransaction(SPISettings(4000000, MSBFIRST, SPI_MODE0));
  digitalWrite(PIN_CS, LOW);
  for (uint8_t p = 0; p < 8; p++) {
    digitalWrite(PIN_A0, LOW);
    SPI.transfer(0xB0 | p);
    SPI.transfer(0x10 | (COL_OFFSET >> 4));
    SPI.transfer(0x00 | (COL_OFFSET & 0x0F));
    digitalWrite(PIN_A0, HIGH);
    for (uint8_t x = 0; x < 128; x++) SPI.transfer(buf[p * 128 + x]);
  }
  digitalWrite(PIN_CS, HIGH);
  SPI.endTransaction();
}

// ---------------- Dummy data ----------------
float actualTemp = 30.0;   // °C
float setTemp    = 37.0;   // °C
float waterLevel = 90.0;   // %
float flow       = 2.4;    // L/min
float pressure   = 0.22;   // bar
bool  gt38Enabled = false;
bool  lowWater    = false;
int8_t keyFlash   = 0;
float fanAngle    = 0;

const float setpoints[] = {37.0, 36.0, 38.5, 35.0};
uint8_t spIndex = 0;
unsigned long lastSpChange = 0;

void updateSimulation() {
  unsigned long now = millis();

  if (now - lastSpChange > 15000) {
    lastSpChange = now;
    float old = setTemp;
    spIndex = (spIndex + 1) % 4;
    setTemp = setpoints[spIndex];
    keyFlash = (setTemp > old) ? 5 : -5;
  }
  if (keyFlash > 0) keyFlash--;
  if (keyFlash < 0) keyFlash++;
  gt38Enabled = setTemp > 38.0;

  actualTemp += (setTemp - actualTemp) * 0.03 + random(-3, 4) / 100.0;

  static bool refilling = false;
  if (refilling) { waterLevel += 2.0;  if (waterLevel >= 95) refilling = false; }
  else           { waterLevel -= 0.25; if (waterLevel <= 10) refilling = true; }
  lowWater = waterLevel < 20;

  flow     = lowWater ? 0.0 : 2.4 + sin(now / 2000.0) * 0.6;
  pressure = lowWater ? 0.0 : 0.08 + flow * 0.06 + random(-3, 4) / 1000.0;
}

// ---------------- Telemetry to the ESP32 gateway ----------------
// "$HU,actualTemp,setTemp,waterLevel,flow,pressure,gt38,lowWater*XX"
// XX = XOR of every character between '$' and '*', as two hex digits.
void appendField(char *body, size_t size, float value, uint8_t decimals) {
  size_t n = strlen(body);
  if (n + 12 >= size) return;
  body[n++] = ',';
  dtostrf(value, 0, decimals, body + n);   // AVR printf has no %f
}

void sendTelemetry() {
  char body[64] = "HU";
  appendField(body, sizeof(body), actualTemp, 1);
  appendField(body, sizeof(body), setTemp, 1);
  appendField(body, sizeof(body), waterLevel, 1);
  appendField(body, sizeof(body), flow, 2);
  appendField(body, sizeof(body), pressure, 3);
  appendField(body, sizeof(body), gt38Enabled ? 1 : 0, 0);
  appendField(body, sizeof(body), lowWater ? 1 : 0, 0);

  uint8_t checksum = 0;
  for (const char *p = body; *p; p++) checksum ^= (uint8_t)*p;
  char tail[5];
  snprintf(tail, sizeof(tail), "*%02X", checksum);
  Serial.print('$');
  Serial.print(body);
  Serial.println(tail);
}

// ---------------- UI drawing ----------------
bool blinkOn() { return (millis() / 400) % 2; }

void drawDegC(int x, int y) {
  u8g2.drawCircle(x + 1, y + 1, 1);
  u8g2.setFont(u8g2_font_5x7_tr);
  u8g2.drawStr(x + 4, y + 7, "C");
}

void drawWaterLevel() {
  u8g2.drawFrame(0, 0, 10, 56);
  int h = (int)(waterLevel * 53 / 100.0);
  u8g2.drawBox(2, 55 - h, 6, h);
  u8g2.drawHLine(10, 6, 3);
  u8g2.drawHLine(10, 45, 3);
  u8g2.setFont(u8g2_font_5x7_tr);
  u8g2.drawStr(3, 63, "W");
}

void drawActualTemp() {
  char buf[8];
  u8g2.setFont(u8g2_font_5x7_tr);
  u8g2.drawStr(15, 7, "ACTUAL");
  dtostrf(actualTemp, 4, 1, buf);
  u8g2.setFont(u8g2_font_logisoso20_tn);
  u8g2.drawStr(15, 31, buf);
  drawDegC(15 + u8g2.getStrWidth(buf) + 2, 12);
}

void drawSetpointPanel() {
  char buf[8];
  u8g2.drawFrame(84, 0, 44, 33);
  u8g2.setFont(u8g2_font_5x7_tr);
  u8g2.drawStr(87, 8, "SET");
  dtostrf(setTemp, 4, 1, buf);
  u8g2.setFont(u8g2_font_7x13B_tr);
  u8g2.drawStr(87, 21, buf);

  u8g2.drawTriangle(117, 10, 125, 10, 121, 5);
  u8g2.drawTriangle(117, 14, 125, 14, 121, 19);
  if (keyFlash > 0) u8g2.drawFrame(115, 3, 12, 9);
  if (keyFlash < 0) u8g2.drawFrame(115, 13, 12, 8);

  u8g2.setFont(u8g2_font_5x7_tr);
  if (gt38Enabled) {
    u8g2.drawBox(87, 23, 38, 9);
    u8g2.setDrawColor(0); u8g2.drawStr(91, 30, ">38:ON"); u8g2.setDrawColor(1);
  } else {
    u8g2.drawFrame(87, 23, 38, 9);
    u8g2.drawStr(91, 30, ">38:--");
  }
}

void drawStatusBar() {
  const char *msg;
  bool alarm = false;
  if (lowWater)                         { msg = "LOW WATER!"; alarm = true; }
  else if (actualTemp < setTemp - 0.3)  msg = "HEATING...";
  else if (actualTemp > setTemp + 0.3)  msg = "ABOVE SETPOINT";
  else                                  msg = "READY - STABLE";

  u8g2.setFont(u8g2_font_6x10_tr);
  int x = 28 + (100 - u8g2.getStrWidth(msg)) / 2;

  bool inverted = alarm && blinkOn();
  if (inverted) { u8g2.drawBox(14, 35, 114, 13); u8g2.setDrawColor(0); }
  else          { u8g2.drawFrame(14, 35, 114, 13); }

  if (alarm) u8g2.drawDisc(21, 41, 3);     // fault lamp ON
  else       u8g2.drawCircle(21, 41, 3);   // fault lamp OFF
  u8g2.drawStr(x, 45, msg);
  u8g2.setDrawColor(1);
}

// Ender-3 style fan: dark square with light blades, spins with flow
void drawFan(int x, int y, bool running) {
  const int cx = x + 7, cy = y + 7, r = 6;
  if (running) { u8g2.drawBox(x, y, 15, 15); u8g2.setDrawColor(0); }
  else         { u8g2.drawFrame(x, y, 15, 15); }

  for (uint8_t i = 0; i < 4; i++) {
    float a = fanAngle + i * HALF_PI;
    u8g2.drawTriangle(cx, cy,
                      cx + cos(a) * r,        cy + sin(a) * r,
                      cx + cos(a + 0.8) * r,  cy + sin(a + 0.8) * r);
  }
  u8g2.setDrawColor(running ? 1 : 0);
  u8g2.drawPixel(cx, cy);                   // hub
  u8g2.setDrawColor(1);
}

void drawBottomRow() {
  char buf[8], line[16];

  drawFan(14, 49, flow > 0.05);

  u8g2.setFont(u8g2_font_5x7_tr);
  u8g2.drawStr(32, 55, "FLOW");
  dtostrf(flow, 3, 1, buf);
  snprintf(line, sizeof(line), "%sL/m", buf);
  u8g2.drawStr(32, 63, line);

  dtostrf(pressure, 4, 2, buf);
  snprintf(line, sizeof(line), "P:%s bar", buf);
  u8g2.drawStr(72, 55, line);
  u8g2.drawFrame(72, 58, 56, 6);
  int w = (int)(constrain(pressure, 0, PRESS_MAX) / PRESS_MAX * 54);
  if (w > 0) u8g2.drawBox(73, 59, w, 4);
}

// ---------------- Main ----------------
void setup() {
  Serial.begin(115200);                     // telemetry to the ESP32 gateway
  u8g2.begin();
  u8g2.setContrast(100);
  u8g2.setFontMode(1);
  lcdCmd(0x40 | START_LINE);
  clearFullRam();
  randomSeed(analogRead(A1));
}

void loop() {
  static unsigned long lastSim = 0;
  if (millis() - lastSim >= 200) {
    lastSim = millis();
    updateSimulation();
  }

  static unsigned long lastTelemetry = 0;
  if (millis() - lastTelemetry >= 1000) {
    lastTelemetry = millis();
    sendTelemetry();
  }

  // Fan speed follows flow (step kept below 45° so it never looks like it spins backwards)
  if (flow > 0.05) fanAngle += (flow / 4.0) * 0.1;
  if (fanAngle > TWO_PI) fanAngle -= TWO_PI;

  u8g2.clearBuffer();
  drawWaterLevel();
  drawActualTemp();
  drawSetpointPanel();
  drawStatusBar();
  drawBottomRow();
  sendBufferFixed();

  delay(40);
}
