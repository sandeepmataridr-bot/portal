// Copy this file to secrets.h (same folder) and fill it in.
// secrets.h is git-ignored: the Wi-Fi password and machine tokens never reach the repository.
#pragma once

#define WIFI_SSID "your-wifi-name"
#define WIFI_PASSWORD "your-wifi-password"

// Where the portal receives device data:
//   portal on your PC (same Wi-Fi): "http://<PC IP address>:3000/vigil/ingest"   e.g. http://192.168.0.103:3000/vigil/ingest
//   hosted portal:                  "https://app.0dh.in/api/vigil/ingest"
#define SERVER_URL "http://192.168.0.103:3000/vigil/ingest"

// One block per machine (six: ECMO, EBOO, three monitors, infusion pump). For each one you want simulated:
//   1. Admin -> Machine Fleet -> Register New Machine, with the type shown here and a room.
//   2. Superuser -> Admin tab -> that machine -> "Issue credential" (the token is shown only once).
//   3. Paste its code, Machine ID and Token below.
// A machine whose ID is left as zeros is not simulated.

// Type: ECMO
#define ECMO_CODE "ECMO-001"
#define ECMO_ID "00000000-0000-0000-0000-000000000000"
#define ECMO_TOKEN "paste-the-64-character-token-here"

// Type: EBOO
#define EBOO_CODE "EBOO-001"
#define EBOO_ID "00000000-0000-0000-0000-000000000000"
#define EBOO_TOKEN "paste-the-64-character-token-here"

// Type: SpO2 monitor
#define SPO2_CODE "SPO2-001"
#define SPO2_ID "00000000-0000-0000-0000-000000000000"
#define SPO2_TOKEN "paste-the-64-character-token-here"

// Type: Temperature monitor
#define TEMP_CODE "TEMP-001"
#define TEMP_ID "00000000-0000-0000-0000-000000000000"
#define TEMP_TOKEN "paste-the-64-character-token-here"

// Type: Multi-parameter monitor
#define MULTI_CODE "MULT-001"
#define MULTI_ID "00000000-0000-0000-0000-000000000000"
#define MULTI_TOKEN "paste-the-64-character-token-here"

// Type: Infusion pump (sends live status over /sync, derived from SERVER_URL)
#define PUMP_CODE "PUMP-001"
#define PUMP_ID "00000000-0000-0000-0000-000000000000"
#define PUMP_TOKEN "paste-the-64-character-token-here"
