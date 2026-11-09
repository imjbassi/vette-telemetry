#include "pids.h"
#include "obd_ble.h"
#include "config.h"

namespace pids {

// Consecutive failures per mode 01 PID. After 3 we stop asking this session.
static uint8_t s_fail[256];
static const uint8_t kMaxFail = 3;

static uint8_t  s_fuelRaw;
static uint16_t s_ecuMv;
static uint32_t s_odoHm;
static uint16_t s_slowValid;

void reset() {
  memset(s_fail, 0, sizeof(s_fail));
  s_slowValid = 0;
}

static int hexNibble(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  return -1;
}

bool parseMode01(const String& rsp, uint8_t pid, uint8_t* out, int nbytes) {
  char hdr[5];
  snprintf(hdr, sizeof(hdr), "41%02X", pid);
  int start = 0;
  while (start < (int)rsp.length()) {
    int end = rsp.indexOf('\n', start);
    if (end < 0) end = rsp.length();
    String line = rsp.substring(start, end);
    line.replace(" ", "");
    line.toUpperCase();
    if (line.startsWith(hdr) && (int)line.length() >= 4 + nbytes * 2) {
      for (int i = 0; i < nbytes; i++) {
        int hi = hexNibble(line[4 + i * 2]), lo = hexNibble(line[5 + i * 2]);
        if (hi < 0 || lo < 0) return false;
        out[i] = (uint8_t)((hi << 4) | lo);
      }
      return true;
    }
    start = end + 1;
  }
  return false;
}

// "010C1": trailing response count makes the STN return after the first reply
// instead of waiting out the timeout for other ECUs.
static bool query(uint8_t pid, uint8_t* out, int nbytes) {
  if (s_fail[pid] >= kMaxFail) return false;
  char c[8];
  snprintf(c, sizeof(c), "01%02X1", pid);
  String r = obd::cmd(c, OBD_CMD_TIMEOUT_MS);
  if (parseMode01(r, pid, out, nbytes)) { s_fail[pid] = 0; return true; }
  if (++s_fail[pid] == kMaxFail) Serial.printf("[pid] 01%02X unsupported (%s)\n", pid, r.c_str());
  return false;
}

float adapterVolts() {
  String r = obd::cmd("ATRV", OBD_CMD_TIMEOUT_MS);  // "14.2V"
  if (!r.length()) return NAN;
  float v = r.toFloat();
  return v > 0.5f ? v : NAN;
}

void pollFast(Record& r) {
  uint8_t b[4];
  if (query(0x0C, b, 2)) { r.rpm = ((b[0] << 8) | b[1]) / 4; r.valid |= V_RPM; }
  if (query(0x0D, b, 1)) { r.speed_kph = b[0]; r.valid |= V_SPEED; }
  if (query(0x10, b, 2)) { r.maf_cgs = (b[0] << 8) | b[1]; r.valid |= V_MAF; }  // (256A+B)/100 g/s
  if (query(0x11, b, 1)) { r.throttle_pct = (uint8_t)(b[0] * 100 / 255); r.valid |= V_THROTTLE; }
  if (query(0x05, b, 1)) { r.coolant_dc = (int16_t)((b[0] - 40) * 10); r.valid |= V_COOLANT; }
  if (query(0x0F, b, 1)) { r.intake_dc = (int16_t)((b[0] - 40) * 10); r.valid |= V_INTAKE; }
}

void pollSlow(Record& r) {
  uint8_t b[4];
  if (query(0x2F, b, 1)) { s_fuelRaw = b[0]; s_slowValid |= V_FUEL; }
  if (query(0x42, b, 2)) { s_ecuMv = (b[0] << 8) | b[1]; s_slowValid |= V_ECU_V; }
  if (query(0xA6, b, 4)) {
    s_odoHm = ((uint32_t)b[0] << 24) | ((uint32_t)b[1] << 16) | ((uint32_t)b[2] << 8) | b[3];
    s_slowValid |= V_ODO;
  }
  carrySlow(r);
}

void carrySlow(Record& r) {
  if (s_slowValid & V_FUEL)  r.fuel_raw = s_fuelRaw;
  if (s_slowValid & V_ECU_V) r.ecu_mv = s_ecuMv;
  if (s_slowValid & V_ODO)   r.odo_hm = s_odoHm;
  r.valid |= s_slowValid;
}

float instantMpg(float mafGs, float speedKph) {
  if (mafGs < 0.5f) return NAN;
  float galPerHour = mafGs * 3600.0f / (AFR_STOICH * GASOLINE_G_PER_GAL);
  return (speedKph * 0.621371f) / galPerHour;
}

float gallonsFromMaf(float mafGs, float dtSec) {
  return mafGs * dtSec / (AFR_STOICH * GASOLINE_G_PER_GAL);
}

}  // namespace pids
