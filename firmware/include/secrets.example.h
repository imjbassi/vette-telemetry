#pragma once
// Copy to secrets.h (gitignored) and fill in.

// Backend
#define INGEST_HOST   "vette-telemetry.YOURNAME.workers.dev"
#define INGEST_PATH   "/ingest"
#define DEVICE_TOKEN  "replace-with-32-hex-chars"   // must match DEVICE_TOKEN secret in the Worker

// Cellular (sim7670g env). EIOTCLUB APN depends on the ICCID prefix.
// Firmware prints the ICCID at boot. Common US value: "america.bics".
#define MODEM_APN     "america.bics"

// WiFi (atoms3 env, desk testing only)
#define WIFI_SSID     ""
#define WIFI_PASS     ""
