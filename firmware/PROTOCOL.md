# Controller → gateway wire protocol

The ECMO controller and the heater-unit controller each send their readings to the ESP32 gateway (`esp32-ecmo-gateway/`) over their own serial line. The gateway turns them into HL7 messages for the portal (see `docs/vigil/esp32.md`).

## Wiring

| From | To: ESP32 gateway | To: ESP32-S3 gateway | Notes |
|---|---|---|---|
| ECMO controller TX | GPIO 25 (`Serial1` RX) | GPIO 18 (`Serial1` RX) | If the controller is a 5 V board, add a 1 kΩ / 2 kΩ divider |
| Heater controller TX (Uno/Nano pin 1) | GPIO 16 (`Serial2` RX) | GPIO 16 (`Serial2` RX) | 5 V board: **1 kΩ in series, 2 kΩ to GND** at the ESP32 side |
| GND | GND | GND | Every board's ground connected together |

- Serial settings: 115200 baud, 8N1. The links are one-way (controller → gateway).
- The sketch picks the pins for the board chosen in the Arduino IDE. The gateway's TX pins (26 and 17 on ESP32, 17 and 15 on ESP32-S3) are reserved and unused.
- ESP32-WROVER modules use GPIO 16/17 for PSRAM. On those, move the heater link to GPIO 32/33 in the sketch settings.
- TTL wires up to about 1–2 m are fine for the bench. A product needs RS-485 or CAN transceivers with galvanic isolation between units.

## Line format
Each controller sends one line per second:

```
$<TAG>,<value 1>,<value 2>,...,<value n>*<XX>\r\n
```

- **`XX`:** the XOR of every character between `$` and `*`, written as two uppercase hex digits (NMEA style). The gateway drops a line if:
  - the checksum is wrong
  - the tag is unknown
  - the number of fields is wrong
  - a value isn't a number
- **Decimal point:** `.`, never `,`. No spaces.
- **Empty field:** a reading the unit doesn't have ("not fitted"). The gateway leaves it out of the message.
- **Flags:** `0` or `1`.

### `$HU`: heater unit

| # | Field | Unit | Gateway signal |
|---|---|---|---|
| 1 | actual water temperature | °C | `HU_WATER_TEMP` |
| 2 | set temperature | °C | `HU_SET_TEMP` |
| 3 | water level | % | `HU_WATER_LEVEL` |
| 4 | water-circuit flow | L/min | `HU_WATER_FLOW` (never the patient's blood flow) |
| 5 | water pressure | bar | `HU_WATER_PRESSURE` |
| 6 | above-38 °C mode on | 0/1 | `HU_GT38_ON` |
| 7 | low-water alarm | 0/1 | `HU_LOW_WATER` |

```
$HU,30.2,37.0,90.0,2.40,0.220,0,0*15
```

### `$EC`: ECMO console

| # | Field | Unit | Gateway signal |
|---|---|---|---|
| 1 | blood flow | L/min | `ECMO_BLOOD_FLOW` |
| 2 | pump speed | rpm | `ECMO_PUMP_SPEED` |
| 3 | venous (drainage) pressure | mmHg | `ECMO_P_VENOUS` |
| 4 | pre-oxygenator pressure | mmHg | `ECMO_P_PRE_OXY` |
| 5 | post-oxygenator pressure | mmHg | `ECMO_P_POST_OXY` |
| 6 | oxygenator pressure drop (pre − post) | mmHg | `ECMO_OXY_DELTA_P` |
| 7 | sweep gas flow | L/min | `ECMO_SWEEP_FLOW` |
| 8 | FiO2 | % | `ECMO_FIO2` |
| 9 | blood temperature | °C | `ECMO_BLOOD_TEMP` |
| 10 | bubble detector alarm | 0/1 | `ECMO_BUBBLE_ALARM` |
| 11 | level sensor alarm | 0/1 | `ECMO_LEVEL_ALARM` |

```
$EC,4.21,3200,-40,230,190,40,3.0,100,36.8,0,0*19
$EC,4.21,3200,,,,40,3.0,100,,0,0*2A        (no pressure sensors or blood temperature fitted)
```

## Timing and loss
- Send one line per second.
- If a controller stays silent for more than 3 s, the gateway stops reporting its readings. The portal then shows those readings ageing, and for the ECMO console raises the communication-lost alarm.
- Nothing has to be re-sent: the next line simply carries the current values.

## Snippet for the ECMO controller
Paste this into the controller sketch, put `Serial.begin(115200);` in `setup()`, and call `sendTelemetry()` once a second. Use `NAN` for any reading the controller doesn't have. It works on AVR (Uno/Nano/Mega) and ESP32.

```cpp
// Your variables (replace with the real readings).
float bloodFlow, pumpRpm, pVenous, pPreOxy, pPostOxy, sweepFlow, fio2, bloodTemp;
bool bubbleAlarm, levelAlarm;

void appendField(char *body, size_t size, float value, uint8_t decimals) {
  size_t n = strlen(body);
  if (n + 12 >= size) return;
  body[n++] = ',';
  body[n] = 0;
  if (isnan(value)) return;                 // not fitted: empty field
  dtostrf(value, 0, decimals, body + n);
}

void sendTelemetry() {
  char body[112] = "EC";
  appendField(body, sizeof(body), bloodFlow, 2);
  appendField(body, sizeof(body), pumpRpm, 0);
  appendField(body, sizeof(body), pVenous, 0);
  appendField(body, sizeof(body), pPreOxy, 0);
  appendField(body, sizeof(body), pPostOxy, 0);
  appendField(body, sizeof(body), pPreOxy - pPostOxy, 0);
  appendField(body, sizeof(body), sweepFlow, 1);
  appendField(body, sizeof(body), fio2, 0);
  appendField(body, sizeof(body), bloodTemp, 1);
  appendField(body, sizeof(body), bubbleAlarm ? 1 : 0, 0);
  appendField(body, sizeof(body), levelAlarm ? 1 : 0, 0);

  uint8_t checksum = 0;
  for (const char *p = body; *p; p++) checksum ^= (uint8_t)*p;
  char tail[5];
  snprintf(tail, sizeof(tail), "*%02X", checksum);
  Serial.print('$');
  Serial.print(body);
  Serial.println(tail);
}
```

The heater controller already does the same in `hu-controller/hu-controller.ino`.
