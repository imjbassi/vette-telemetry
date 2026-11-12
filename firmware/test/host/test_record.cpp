// The 48-byte record against the golden record of the change contract. The backend test
// decodes the same bytes, so a layout slip on either side fails a test instead of a drive.
#include <cstring>
#include "check.h"
#include "record.h"

// Golden record. Must stay identical to the one in the backend test.
static const char* kGoldenHex =
    "c8010c0040e201003beff46ad8db8a16684bffb66608d2046437890336015817bf15ff0ff7ee0100e2360b01ad02077c";

static int nibble(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  return -1;
}

static Record goldenFields() {
  Record r = {};
  r.boot = 12;
  r.ms = 123456;
  r.epoch = 1794436923;
  r.lat_e7 = 378199000;
  r.lon_e7 = -1224783000;
  r.rpm = 2150;
  r.maf_cgs = 1234;
  r.adapter_mv = 14180;
  r.coolant_dc = 905;
  r.intake_dc = 310;
  r.speed_kph = 88;
  r.throttle_pct = 23;
  r.fuel_raw = 191;
  r.csq = 21;
  r.valid = 0x0FFF;
  r.odo_hm = 126711;
  r.ecu_mv = 14050;
  r.sats = 11;
  r.flags = F_ENGINE_ON;
  r.inst = 173;
  r.fw = 2;
  return r;
}

int main() {
  uint8_t golden[sizeof(Record)];
  CHECK_EQ(std::strlen(kGoldenHex), 2 * sizeof(Record));
  for (size_t i = 0; i < sizeof(Record); i++) {
    golden[i] = (uint8_t)((nibble(kGoldenHex[2 * i]) << 4) | nibble(kGoldenHex[2 * i + 1]));
  }

  // Fields in, golden bytes out, byte for byte.
  Record r = goldenFields();
  record_seal(r);
  CHECK_EQ(r.magic, 0xC8);
  CHECK_EQ(r.version, 1);
  CHECK_EQ(r.crc, 0x7C07);
  const uint8_t* raw = reinterpret_cast<const uint8_t*>(&r);
  for (size_t i = 0; i < sizeof(Record); i++) {
    if (raw[i] != golden[i]) std::printf("  byte %u: built %02x, golden %02x\n", (unsigned)i, raw[i], golden[i]);
  }
  CHECK(std::memcmp(raw, golden, sizeof(Record)) == 0);

  // Golden bytes in, fields out.
  Record g;
  std::memcpy(&g, golden, sizeof(g));
  CHECK_EQ(g.boot, 12);
  CHECK_EQ(g.ms, 123456);
  CHECK_EQ(g.epoch, 1794436923);
  CHECK_EQ(g.lat_e7, 378199000);
  CHECK_EQ(g.lon_e7, -1224783000);
  CHECK_EQ(g.rpm, 2150);
  CHECK_EQ(g.maf_cgs, 1234);
  CHECK_EQ(g.adapter_mv, 14180);
  CHECK_EQ(g.coolant_dc, 905);
  CHECK_EQ(g.intake_dc, 310);
  CHECK_EQ(g.speed_kph, 88);
  CHECK_EQ(g.throttle_pct, 23);
  CHECK_EQ(g.fuel_raw, 191);
  CHECK_EQ(g.csq, 21);
  CHECK_EQ(g.valid, 0x0FFF);
  CHECK_EQ(g.odo_hm, 126711);
  CHECK_EQ(g.ecu_mv, 14050);
  CHECK_EQ(g.sats, 11);
  CHECK_EQ(g.flags, 1);
  CHECK_EQ(g.inst, 173);
  CHECK_EQ(g.fw, 2);
  CHECK_EQ(g.crc, 0x7C07);
  // The backend's session id for this record.
  CHECK_EQ(g.boot + g.inst * 65536L, 11337740);

  // CRC-16/CCITT-FALSE over bytes 0..45, stored little-endian at 46.
  CHECK_EQ(crc16_ccitt(golden, 46), 0x7C07);
  CHECK_EQ(golden[46], 0x07);
  CHECK_EQ(golden[47], 0x7C);
  CHECK_EQ(crc16_ccitt(reinterpret_cast<const uint8_t*>("123456789"), 9), 0x29B1);  // the standard check value

  // Any flipped bit must break the CRC.
  for (size_t i = 0; i < 46; i++) {
    uint8_t bad[sizeof(Record)];
    std::memcpy(bad, golden, sizeof(bad));
    bad[i] ^= 0x10;
    if (crc16_ccitt(bad, 46) == 0x7C07) {
      CHECK(!"a flipped bit went unnoticed");
      break;
    }
  }

  // Flag and valid bit values are part of the wire format.
  CHECK_EQ(F_ENGINE_ON, 1);
  CHECK_EQ(F_QUIET, 2);
  CHECK_EQ(F_NO_LINK, 4);
  CHECK_EQ(V_RPM | V_SPEED | V_COOLANT | V_INTAKE | V_MAF | V_THROTTLE | V_FUEL | V_ECU_V | V_ODO | V_ADAPTER_V |
               V_GPS | V_CSQ,
           0x0FFF);
  CHECK_EQ(V_ADAPTER_V, 0x0200);
  CHECK_EQ(V_GPS, 0x0400);
  CHECK_EQ(V_CSQ, 0x0800);

  // A sealed all-zero record still carries magic, version and a matching CRC.
  Record z = {};
  record_seal(z);
  CHECK_EQ(z.crc, crc16_ccitt(reinterpret_cast<const uint8_t*>(&z), 46));

  return finish("test_record");
}
