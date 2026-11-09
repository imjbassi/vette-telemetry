#pragma once
#include <stdint.h>

// ---- BLE / OBDLink CX ----
// Vendor docs: notify FFF1, write FFF2 (write + write-without-response). Service FFF0.
#define OBD_NAME_PREFIX      "OBDLink"
#define OBD_SERVICE_UUID     "FFF0"
#define OBD_NOTIFY_UUID      "FFF1"
#define OBD_WRITE_UUID       "FFF2"
#define OBD_CMD_TIMEOUT_MS   1500
#define OBD_INIT_TIMEOUT_MS  6000   // ATZ / protocol search

// ---- Polling ----
#define POLL_PERIOD_MS       1000   // fast PIDs
#define SLOW_EVERY_N         10     // fuel level, odometer, module voltage every N fast cycles
#define ENGINE_ON_VOLTS      13.0f  // ATRV threshold. Below this, stop querying ECUs.
#define ENGINE_OFF_GRACE_MS  20000  // engine-off must persist this long before we go quiet
#define IDLE_PROBE_MS        10000  // ATRV probe interval while quiet (adapter-local, no CAN traffic)

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
