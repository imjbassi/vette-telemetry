#pragma once
#include <stdint.h>

// ---- Identity ----
// Written into byte 45 of every record. 0 = firmware from before this byte existed.
// 2 = stage 1 (outage-proof queue, engine gate, install id). Raise it with every flash
// that changes behavior, so the backend can tell which firmware wrote a session.
#define FW_BUILD             2

// Desk build with a scripted adapter and a scripted network (env atoms3-bench).
#ifndef BENCH
#define BENCH 0
#endif

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
// Default ELM protocol: 7 = ISO 15765-4 CAN, 29-bit IDs, 500 kbaud. This is what the 2024
// C8 answered on (6, the 11-bit variant, got NO DATA). Fixed so the adapter never runs its
// multi-second "SEARCHING..." pass, which a 1 Hz poller would keep interrupting. If a
// search ever finds a different protocol, that one is saved in NVS and used instead.
#define OBD_PROTOCOL         "7"

// ---- Polling ----
#define POLL_PERIOD_MS       1000   // fast PIDs
#define SLOW_EVERY_N         10     // fuel level, odometer, module voltage every N fast cycles
#define QUIET_TICK_MS        2000   // ATRV interval while quiet (adapter-local, no CAN traffic)
// When to probe the car while quiet, and when to go quiet: see engine_gate.h.

// ---- Fuel math ----
#define AFR_STOICH           14.1f     // pump E10. 14.7 is pure gasoline. Same value as the backend.
#define GASOLINE_G_PER_GAL   2798.7f   // 6.17 lb/gal
#define TANK_GAL             18.5f     // C8 Stingray

// ---- Storage / upload ----
#define FLUSH_EVERY          5      // records per fsync. Power cut loses at most this many.
// Each upload is a fresh HTTPS session on the modem, so the TLS handshake dominates data use:
// roughly 1.5 MB per hour of driving at 15 s.
#define UPLOAD_PERIOD_MS     15000  // while the engine gate is active
#define UPLOAD_IDLE_PERIOD_MS 60000 // while quiet or with no adapter link
#define UPLOAD_MAX_WAIT_MS   300000 // ceiling for the wait after HTTP 400 to 599
#define UPLOAD_MAX_POSTS     4      // POSTs per pass, so GNSS and signal keep being read
#define NET_BEGIN_RETRY_MS   30000  // network bring-up is tried again this often until it works
// One upload body. A segment file never holds more than this: 341 records.
#define MAX_UPLOAD_BYTES     16384
// Body size after three refused larger uploads in a row, for the rest of the boot: 30
// records. The largest upload proven on the real modem and Worker so far is 31 records.
#define UPLOAD_FALLBACK_BYTES 1440
// Above this share of the LittleFS partition the oldest closed segments are deleted.
#define QUEUE_MAX_PCT        80

// ---- Modem (Waveshare ESP32-S3-SIM7670G-4G) ----
#define MODEM_RX_PIN         17     // ESP32 RX <- modem TXD
#define MODEM_TX_PIN         18     // ESP32 TX -> modem RXD
#define MODEM_BAUD           115200
#define GNSS_PERIOD_MS       5000
