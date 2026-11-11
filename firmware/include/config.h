#pragma once
#include <stdint.h>

// ---- BLE / OBDLink CX ----
// Vendor docs: notify FFF1, write FFF2 (write + write-without-response). Service FFF0.
#define OBD_NAME_PREFIX      "OBDLink"
#define OBD_SERVICE_UUID     "FFF0"
#define OBD_NOTIFY_UUID      "FFF1"
#define OBD_WRITE_UUID       "FFF2"
#define OBD_CMD_TIMEOUT_MS   1500
#define OBD_INIT_TIMEOUT_MS  6000   // ATZ
#define OBD_PROBE_TIMEOUT_MS 3000   // 0100 on the fixed protocol
#define OBD_SEARCH_TIMEOUT_MS 12000 // 0100 with automatic protocol search (fallback only)
// ISO 15765-4 CAN, 11-bit, 500 kbaud. Fixed so the adapter never runs its multi-second
// "SEARCHING..." pass, which a 1 Hz poller would keep interrupting.
#define OBD_PROTOCOL         "6"

// ---- Polling ----
#define POLL_PERIOD_MS       1000   // fast PIDs
#define SLOW_EVERY_N         10     // fuel level, odometer, module voltage every N fast cycles
#define ENGINE_ON_VOLTS      13.0f  // ATRV at or above this means the alternator is charging
#define ENGINE_OFF_GRACE_MS  20000  // no RPM and no charging for this long before going quiet
#define QUIET_TICK_MS        2000   // ATRV interval while quiet (adapter-local, no CAN traffic)
#define CHARGING_PROBE_MS    5000   // while quiet and charging: how often to try the ECU
#define QUIET_RPM_PROBE_MS   30000  // while quiet and not charging: one RPM request this often

// ---- Fuel math ----
#define AFR_STOICH           14.7f
#define GASOLINE_G_PER_GAL   2798.7f   // 6.17 lb/gal
#define TANK_GAL             18.5f     // C8 Stingray

// ---- Storage / upload ----
#define FLUSH_EVERY          5      // records per fsync. Power cut loses at most this many.
#define UPLOAD_PERIOD_MS     30000
#define MAX_UPLOAD_BYTES     16384
#define QUEUE_MAX_BYTES      (4 * 1024 * 1024)  // drop oldest segments past this

// ---- Modem (Waveshare ESP32-S3-SIM7670G-4G) ----
#define MODEM_RX_PIN         17     // ESP32 RX <- modem TXD
#define MODEM_TX_PIN         18     // ESP32 TX -> modem RXD
#define MODEM_BAUD           115200
#define GNSS_PERIOD_MS       5000
