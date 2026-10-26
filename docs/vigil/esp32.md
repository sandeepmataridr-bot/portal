# ESP32 gateway: ECMO and heater-unit data into the portal

The ECMO console and the heater unit each have their own controller. Both send their readings to one ESP32 gateway, which sends them to the portal:

```
ECMO controller --serial--> ESP32 gateway --Wi-Fi / HTTPS--> portal (POST /vigil/ingest) --> ECMO central station
Heater controller -serial-/
```

- **Same path as real data:** the gateway sends exactly what a console attached to a patient would send. The portal runs in Vigil **LIVE** mode and handles the readings as real information, whether the controllers produce dummy values (bench) or real ones.
- **No server change for real patients.** Moving to real patients only means tagging the machine to a real patient.
- **What does have to change first:** where the portal runs. Real patient data must never be on free hosting; it needs hospital-side or BAA-covered hosting.

| File | What it is |
|---|---|
| [`firmware/esp32-ecmo-gateway/`](../../firmware/esp32-ecmo-gateway/) | Gateway sketch (Arduino IDE, esp32 core 3.x, no extra libraries) |
| [`firmware/hu-controller/`](../../firmware/hu-controller/) | Heater-unit controller sketch (Uno/Nano) with telemetry added |
| [`firmware/PROTOCOL.md`](../../firmware/PROTOCOL.md) | Controller → gateway line format, wiring, and the snippet for the ECMO controller |

## Set-up

1. **Portal in LIVE mode** (once). In the API environment (`apps/api/.env`, or `infra/docker/.env.prod` when hosted):
   ```
   VIGIL_LIVE_MODE=true
   VIGIL_LIVE_TENANT_ID=0dh-hospital    (must not start with "sim")
   VIGIL_LIVE_UNIT_ID=icu-1
   ```
   Then restart the API.

   No `VIGIL_HL7_CODES` is needed, because the gateway's codes are built in. On the hosted (production) server in LIVE mode the quick sign-in table on the login screen is off, so staff use their own accounts; a local development API with `TEST_LOGINS=true` still shows it.
2. **Admin dashboard → Register New Machine:** type **ECMO**, code e.g. `ECMO-001`.
3. **Issue credential** on that machine. Copy the **Machine ID** and **Token**; the token is shown only once.
4. **Gateway:**
   - Copy `secrets.example.h` to `secrets.h` and fill in the Wi-Fi details, `SERVER_URL`, `MACHINE_CODE`, `MACHINE_ID` and `MACHINE_TOKEN`.
   - `secrets.h` is git-ignored.
5. **Arduino IDE:**
   - Install the board package **esp32 by Espressif** (3.x) and choose **ESP32 Dev Module** (or **ESP32S3 Dev Module** for an ESP32-S3 gateway; the sketch then uses the S3 pins in PROTOCOL.md).
   - For a portal on your PC: the ESP32 must join the same network as the PC, and Windows must treat that network as **Private**, since Node.js is allowed through the firewall only on Private networks.
   - Open `esp32-ecmo-gateway.ino` and upload.
   - The Serial Monitor (115200) prints a status line every 10 s: Wi-Fi, clock, each controller link, queue, and the last send result.
6. **Controllers:** wire them as in [PROTOCOL.md](../../firmware/PROTOCOL.md), then set `DEMO_SOURCES 0` in the gateway.

   With `DEMO_SOURCES 1` (the default), the gateway simulates both controllers itself, so steps 1–5 can be checked before any wiring.
7. **Portal:** register the patient as usual (reception). Then, in **Admin dashboard → Fleet**, assign `ECMO-001` to that patient.
8. **Doctor → ECMO central station:** the machine first appears as *unassociated* with live readings. After the patient is assigned, press **Confirm association** once the console is checked at the bedside. The rules start running.

## `SERVER_URL`

| Portal | `SERVER_URL` |
|---|---|
| On a PC in the same Wi-Fi (dev server) | `http://<PC IP address>:3000/vigil/ingest`: the API port directly, no `/api` prefix. Windows must let TCP 3000 in from the local network: a Private network profile, or an inbound rule for port 3000 with remote address "Local subnet" (Windows block rules for Node.js on Public networks win over allow rules). |
| Hosted | `https://app.0dh.in/api/vigil/ingest` (HTTPS; the gateway carries the Let's Encrypt and Google Trust Services root certificates) |

If the hosted portal sits behind Cloudflare Access, add an Access **Bypass** policy for the path `/api/vigil/ingest`. The machine token still protects it, and the gateway can't answer an email login.

## What the gateway sends
Every second, one HL7 v2 ORU^R01 message (IHE PCD-01) holding the latest readings of every controller heard in the last 3 s, timestamped in UTC from NTP. Up to 20 queued messages go in one request:

```
POST /vigil/ingest
X-Machine-Id: <machine id>
X-Machine-Token: <token>
Content-Type: application/json

{"driver":"hl7_pcd01","frames":["MSH|^~\\&|ESP32GW|ECMO-001|0DH|PORTAL|20261022130000+0000||ORU^R01^ORU_R01|GW00000042|P|2.6\rOBR|1|||ECMO^ECMO monitoring^0DH|||20261022130000+0000\rOBX|1|NM|ECMO_BLOOD_FLOW^ECMO_BLOOD_FLOW^0DH||4.21|L/min^L/min^UCUM|||||F|||20261022130000+0000\r..."]}
```

- Each `OBX` carries the code `<SIGNAL>^<SIGNAL>^0DH`, the value, the unit as `<UCUM>^<UCUM>^UCUM`, status `F`, and the time. A reading the controller doesn't have gets no OBX.
- The response holds one HL7 ACK per message:
  - `MSA|AA`: accepted.
  - `MSA|AE|<id>|<reason>`: rejected, e.g. a malformed message. The gateway prints the reason.

| Response | Meaning | Gateway |
|---|---|---|
| 201 | Accepted (see the ACKs) | Drops the sent messages from its queue |
| 401 | Machine ID or token wrong, or credential re-issued | Waits 30 s; check `secrets.h` |
| 403 | Portal not in LIVE mode, or the machine isn't type ECMO | Waits 30 s, keeps the queue |
| 400 | Request malformed | Drops those messages |
| 429 / network error / 5xx | Busy or unreachable | Retries after 10 s / 5 s; keeps up to 300 messages (~5 min) |

## Signals

| Code | Unit (UCUM) | Shown as |
|---|---|---|
| `ECMO_BLOOD_FLOW` | `L/min` | Blood flow |
| `ECMO_PUMP_SPEED` | `{rpm}` | Pump speed |
| `ECMO_P_VENOUS` | `mm[Hg]` | Venous (drainage) pressure |
| `ECMO_P_PRE_OXY` | `mm[Hg]` | Pressure before the oxygenator |
| `ECMO_P_POST_OXY` | `mm[Hg]` | Pressure after the oxygenator |
| `ECMO_OXY_DELTA_P` | `mm[Hg]` | Oxygenator pressure drop |
| `ECMO_SWEEP_FLOW` | `L/min` | Sweep gas flow (setting) |
| `ECMO_FIO2` | `%` | FiO2 (setting) |
| `ECMO_BLOOD_TEMP` | `Cel` | Blood temperature |
| `ECMO_BUBBLE_ALARM` | `{flag}` | Air bubble detector: OK / ALARM |
| `ECMO_LEVEL_ALARM` | `{flag}` | Level sensor: OK / ALARM |
| `HU_WATER_TEMP` | `Cel` | Heater water temperature |
| `HU_SET_TEMP` | `Cel` | Heater set temperature (setting) |
| `HU_WATER_LEVEL` | `%` | Heater water level |
| `HU_WATER_FLOW` | `L/min` | Heater water flow (water circuit, never blood flow) |
| `HU_WATER_PRESSURE` | `bar` | Heater water pressure |
| `HU_GT38_ON` | `{flag}` | Above-38 °C mode: ON / OFF (setting) |
| `HU_LOW_WATER` | `{flag}` | Heater low-water alarm: OK / ALARM |

**Alarms that run on this data today:**
- **ECMO blood-flow loss:** flow < 1.5 L/min for 5 s.
- **ECMO communication lost:** no blood flow data for 10 s.
- **Oxygenator failure trend.**

The new readings are displayed; alarm limits for them (e.g. pump speed, temperatures, the bubble and low-water flags) need clinically agreed thresholds and are a follow-up in `packages/vigil/rules/`.

## Later: product firmware
The bench gateway is an Arduino sketch. The product version moves to ESP-IDF, with:
- secure boot and flash encryption
- the token in encrypted NVS
- task watchdogs
- OTA updates with rollback
- RS-485 or CAN with isolation for the controller links

It keeps the same structure (links → latest values → message queue → sender) and the same messages, so the portal stays as it is.
