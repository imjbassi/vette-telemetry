#include "pids.h"
#include "obd_ble.h"
#include "config.h"

namespace pids {

// A supported PID that keeps answering NO DATA is dropped for the session. Timeouts and
// bus errors do not count, since they say nothing about the PID itself.
static uint8_t s_noData[256];
static const uint8_t kMaxNoData = 3;

// Supported-PID bitmasks from 0100, 0120, ... 01E0. Bit 31 of mask[i] is PID i*0x20+1.
static uint32_t s_mask[8];
static bool s_haveMask = false;
static uint32_t s_lastSearchMs = 0;

static uint8_t  s_fuelRaw;
static uint16_t s_ecuMv;
static uint32_t s_odoHm;
static uint16_t s_slowValid;

static const uint8_t kOurPids[] = {0x0C, 0x0D, 0x05, 0x0F, 0x10, 0x11, 0x2F, 0x42, 0xA6};

void reset() {
  memset(s_noData, 0, sizeof(s_noData));
  memset(s_mask, 0, sizeof(s_mask));
  s_haveMask = false;
  s_slowValid = 0;
}

static int hexNibble(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  return -1;
}

// Calls fn(out) for every response line that starts with "41PP" and carries nbytes of
// data. With headers off, each responding ECU produces one such line. Stops when fn
// returns false. Returns the number of matching lines.
template <typename Fn>
static int forEachReply(const String& rsp, uint8_t pid, int nbytes, Fn fn) {
  char hdr[5];
  snprintf(hdr, sizeof(hdr), "41%02X", pid);
  int found = 0, start = 0;
  while (start < (int)rsp.length()) {
    int end = rsp.indexOf('\n', start);
    if (end < 0) end = rsp.length();
    String line = rsp.substring(start, end);
    start = end + 1;
    line.replace(" ", "");
    line.toUpperCase();
    if (!line.startsWith(hdr) || (int)line.length() < 4 + nbytes * 2) continue;
    uint8_t out[8];
    bool ok = true;
    for (int i = 0; i < nbytes && ok; i++) {
      int hi = hexNibble(line[4 + i * 2]), lo = hexNibble(line[5 + i * 2]);
      if (hi < 0 || lo < 0) ok = false;
      else out[i] = (uint8_t)((hi << 4) | lo);
    }
    if (!ok) continue;
    found++;
    if (!fn(out)) break;
  }
  return found;
}

bool parseMode01(const String& rsp, uint8_t pid, uint8_t* out, int nbytes) {
  if (nbytes > 8) return false;
  return forEachReply(rsp, pid, nbytes, [&](const uint8_t* b) {
    memcpy(out, b, nbytes);
    return false;  // first ECU wins
  }) > 0;
}

static bool supported(uint8_t pid) {
  if (!s_haveMask || pid == 0) return true;  // unknown: try it
  return s_mask[(pid - 1) / 32] & (0x80000000u >> ((pid - 1) % 32));
}

// "010C1": trailing response count makes the STN return after the first reply
// instead of waiting out the timeout for other ECUs.
static bool query(uint8_t pid, uint8_t* out, int nbytes) {
  if (!supported(pid) || s_noData[pid] >= kMaxNoData) return false;
  char c[8];
  snprintf(c, sizeof(c), "01%02X1", pid);
  String r = obd::cmd(c, OBD_CMD_TIMEOUT_MS);
  if (parseMode01(r, pid, out, nbytes)) { s_noData[pid] = 0; return true; }
  if (r.indexOf("NO DATA") >= 0 && ++s_noData[pid] == kMaxNoData) {
    Serial.printf("[pid] 01%02X keeps returning NO DATA, dropped for this session\n", pid);
  }
  return false;
}

// Reads the support bitmasks. Every ECU that answers contributes its bits.
static bool readMasks(uint32_t firstTimeoutMs, String& why) {
  memset(s_mask, 0, sizeof(s_mask));
  s_haveMask = false;
  for (uint8_t i = 0; i < 8; i++) {
    if (i > 0 && !(s_mask[i - 1] & 1)) break;  // bit 0 = "next range exists"
    char c[6];
    snprintf(c, sizeof(c), "01%02X", i * 0x20);
    String r = obd::cmd(c, i == 0 ? firstTimeoutMs : OBD_PROBE_TIMEOUT_MS);
    uint32_t m = 0;
    int n = forEachReply(r, i * 0x20, 4, [&](const uint8_t* b) {
      m |= ((uint32_t)b[0] << 24) | ((uint32_t)b[1] << 16) | ((uint32_t)b[2] << 8) | b[3];
      return true;
    });
    if (n == 0) {
      if (i == 0) { why = r.length() ? r : String("no reply"); return false; }
      break;
    }
    s_mask[i] = m;
    s_haveMask = true;
  }
  return s_haveMask;
}

static void report() {
  String yes, no;
  for (uint8_t p : kOurPids) {
    char t[4];
    snprintf(t, sizeof(t), "%02X ", p);
    (supported(p) ? yes : no) += t;
  }
  Serial.printf("[pid] ECU supports: %s| not supported: %s\n", yes.c_str(), no.length() ? no.c_str() : "none");
}

bool probe(bool allowSearch) {
  memset(s_noData, 0, sizeof(s_noData));
  String why;
  if (readMasks(OBD_PROBE_TIMEOUT_MS, why)) { report(); return true; }
  why.replace("\n", " / ");
  Serial.printf("[pid] no answer to 0100 on protocol %c (%s)\n", obd::protocol(), why.c_str());

  // Fallback: let the adapter search every protocol, at most once a minute.
  if (!allowSearch || (s_lastSearchMs && millis() - s_lastSearchMs < 60000)) return false;
  s_lastSearchMs = millis();
  Serial.println("[pid] trying the adapter's automatic protocol search (up to 12 s)");
  obd::cmd("ATSP0", OBD_CMD_TIMEOUT_MS);
  bool ok = readMasks(OBD_SEARCH_TIMEOUT_MS, why);
  if (ok) {
    // ATDPN answers like "A7": automatic, protocol 7. Lock it in and remember it.
    String p = obd::cmd("ATDPN", OBD_CMD_TIMEOUT_MS);
    p.trim();
    Serial.printf("[pid] search found protocol %s\n", p.c_str());
    if (p.length() == 2 && p[0] == 'A') p = p.substring(1);
    if (p.length() == 1) {
      obd::setProtocol(p[0]);
      obd::cmd((String("ATSP") + p).c_str(), OBD_CMD_TIMEOUT_MS);
    }
    report();
    return true;
  }
  obd::cmd((String("ATSP") + obd::protocol()).c_str(), OBD_CMD_TIMEOUT_MS);
  return false;
}

bool engineRpm(uint16_t& rpm) {
  uint8_t b[2];
  String r = obd::cmd("010C1", OBD_CMD_TIMEOUT_MS);
  if (!parseMode01(r, 0x0C, b, 2)) return false;
  rpm = ((b[0] << 8) | b[1]) / 4;
  return true;
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
