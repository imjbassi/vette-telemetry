#pragma once
#include <stdint.h>
#include <stddef.h>

// Fixed 48-byte little-endian record. Uploaded as-is and decoded by backend/src/record.ts.
// Keep the two in sync. Bump REC_VERSION on any layout change.
// This header has no Arduino dependency, so the host test in test/host can build it.
#define REC_MAGIC   0xC8
#define REC_VERSION 1

enum ValidBits : uint16_t {
  V_RPM       = 1 << 0,
  V_SPEED     = 1 << 1,
  V_COOLANT   = 1 << 2,
  V_INTAKE    = 1 << 3,
  V_MAF       = 1 << 4,
  V_THROTTLE  = 1 << 5,
  V_FUEL      = 1 << 6,
  V_ECU_V     = 1 << 7,
  V_ODO       = 1 << 8,
  V_ADAPTER_V = 1 << 9,
  V_GPS       = 1 << 10,
  V_CSQ       = 1 << 11,
};

enum RecFlags : uint8_t {
  F_ENGINE_ON = 1 << 0,   // RPM reply above zero in this record, or no RPM reply and one above zero at most 3 s ago
  F_QUIET     = 1 << 1,   // ECU polling suspended (engine off)
  F_NO_LINK   = 1 << 2,   // written while the Bluetooth link to the adapter was down
};

#pragma pack(push, 1)
struct Record {
  uint8_t  magic;        // 0
  uint8_t  version;      // 1
  uint16_t boot;         // 2   ignition cycle / power-on counter
  uint32_t ms;           // 4   millis() since boot
  uint32_t epoch;        // 8   unix seconds, 0 if unknown yet
  int32_t  lat_e7;       // 12
  int32_t  lon_e7;       // 16
  uint16_t rpm;          // 20
  uint16_t maf_cgs;      // 22  MAF in 0.01 g/s
  uint16_t adapter_mv;   // 24  ATRV (battery at OBD pin 16)
  int16_t  coolant_dc;   // 26  0.1 C
  int16_t  intake_dc;    // 28  0.1 C
  uint8_t  speed_kph;    // 30
  uint8_t  throttle_pct; // 31
  uint8_t  fuel_raw;     // 32  PID 2F raw A, percent = A * 100 / 255
  uint8_t  csq;          // 33  modem RSSI 0..31, 99 unknown
  uint16_t valid;        // 34  ValidBits
  uint32_t odo_hm;       // 36  PID A6 raw, 0.1 km units
  uint16_t ecu_mv;       // 40  PID 42 control module voltage
  uint8_t  sats;         // 42
  uint8_t  flags;        // 43  RecFlags
  uint8_t  inst;         // 44  install id, random 1..255 kept in NVS. 0 = firmware before FW_BUILD 2
  uint8_t  fw;           // 45  firmware build (FW_BUILD in config.h). 0 = firmware before FW_BUILD 2
  uint16_t crc;          // 46  CRC-16/CCITT-FALSE over bytes 0..45
};
#pragma pack(pop)

// The backend reads every field by its byte offset, so a moved field must not compile.
static_assert(sizeof(Record) == 48, "Record must be 48 bytes");
static_assert(offsetof(Record, magic) == 0, "magic");
static_assert(offsetof(Record, version) == 1, "version");
static_assert(offsetof(Record, boot) == 2, "boot");
static_assert(offsetof(Record, ms) == 4, "ms");
static_assert(offsetof(Record, epoch) == 8, "epoch");
static_assert(offsetof(Record, lat_e7) == 12, "lat_e7");
static_assert(offsetof(Record, lon_e7) == 16, "lon_e7");
static_assert(offsetof(Record, rpm) == 20, "rpm");
static_assert(offsetof(Record, maf_cgs) == 22, "maf_cgs");
static_assert(offsetof(Record, adapter_mv) == 24, "adapter_mv");
static_assert(offsetof(Record, coolant_dc) == 26, "coolant_dc");
static_assert(offsetof(Record, intake_dc) == 28, "intake_dc");
static_assert(offsetof(Record, speed_kph) == 30, "speed_kph");
static_assert(offsetof(Record, throttle_pct) == 31, "throttle_pct");
static_assert(offsetof(Record, fuel_raw) == 32, "fuel_raw");
static_assert(offsetof(Record, csq) == 33, "csq");
static_assert(offsetof(Record, valid) == 34, "valid");
static_assert(offsetof(Record, odo_hm) == 36, "odo_hm");
static_assert(offsetof(Record, ecu_mv) == 40, "ecu_mv");
static_assert(offsetof(Record, sats) == 42, "sats");
static_assert(offsetof(Record, flags) == 43, "flags");
static_assert(offsetof(Record, inst) == 44, "inst");
static_assert(offsetof(Record, fw) == 45, "fw");
static_assert(offsetof(Record, crc) == 46, "crc");

inline uint16_t crc16_ccitt(const uint8_t* p, size_t n) {
  uint16_t c = 0xFFFF;
  while (n--) {
    c ^= (uint16_t)(*p++) << 8;
    for (int i = 0; i < 8; i++) c = (c & 0x8000) ? (c << 1) ^ 0x1021 : (c << 1);
  }
  return c;
}

inline void record_seal(Record& r) {
  r.magic = REC_MAGIC;
  r.version = REC_VERSION;
  r.crc = crc16_ccitt(reinterpret_cast<const uint8_t*>(&r), offsetof(Record, crc));
}
