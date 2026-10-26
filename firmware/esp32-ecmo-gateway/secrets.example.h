// Copy this file to secrets.h (same folder) and fill it in.
// secrets.h is git-ignored: the Wi-Fi password and machine token never reach the repository.
#pragma once

#define WIFI_SSID "Pragnya"
#define WIFI_PASSWORD "11111111"

// Where the portal receives device data:
//   portal on your PC (same Wi-Fi): "http://<PC IP address>:3000/vigil/ingest"   e.g. http://192.168.0.103:3000/vigil/ingest
//   hosted portal:                  "https://app.0dh.in/api/vigil/ingest"
#define SERVER_URL "http://192.168.0.103:3000/vigil/ingest"

// Admin dashboard -> the ECMO machine -> "Issue credential" (the token is shown only once).
#define MACHINE_CODE "ECMO-001"
#define MACHINE_ID "00000000-0000-0000-0000-000000000000"
#define MACHINE_TOKEN "paste-the-64-character-token-here"
