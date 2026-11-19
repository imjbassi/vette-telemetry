// Desk build (env atoms3-bench): a scripted adapter in place of the OBDLink CX.
// No Bluetooth. It answers the same command strings the real adapter gets, from a
// repeating timeline, so the engine gate, the PID layer and the queue run unchanged.
#include "config.h"
#if BENCH
#include "obd_ble.h"

namespace obd {

// One cycle of the scripted car is 10 minutes, then it repeats:
//   0:00  parked     on a charger at 13.4 V, the car answers nothing. Right after boot the
//                    car has not answered once yet, so three unanswered probes at charging
//                    voltage bring the one protocol search of the boot. It finds nothing.
//   0:40  start      2 s crank dip to 10.9 V, then running
//   0:42  drive      14.2 V, but 12.6 V from 2:30 to 3:20 (a running engine can sit near 12 V).
//                    Speed answers NO DATA for the first 10 s of each drive, as the real car
//                    once did. It is skipped, and back about 10 s later.
//   5:00  stop       engine off for 50 s, longer than the 20 s grace, so the gate goes quiet.
//                    The voltage starts at 13.3 V and sinks: unanswered probes at charging
//                    voltage again, but no search, because the car has answered in this boot.
//   5:50  restart    crank dip, then drive
//   8:00  stop       parked, the voltage settles to 12.4 V
static const uint32_t kCycleS = 600;

static bool s_connected = false;
static uint32_t s_t0 = 0;        // millis() at the first connect, start of the timeline
static uint32_t s_lastMs = 0;
static double s_odoKm = 12671.1;
static bool s_searching = false; // ATSP0 was sent and no protocol is fixed yet

struct Car {
  bool engine;   // the ECU answers
  float volts;
  uint16_t rpm;
  uint8_t kph;
  float driveS;  // seconds into the current drive
};

static float offVolts(float sinceStopS) {
  float v = 13.3f - 0.01f * sinceStopS;
  return v < 12.4f ? 12.4f : v;
}

static Car carAt(uint32_t ms) {
  float t = fmodf((ms - s_t0) / 1000.0f, (float)kCycleS);
  Car c = {false, 12.4f, 0, 0, 0};
  float driveStart = -1;
  if (t < 40) { c.volts = 13.4f; return c; }
  if (t < 42) { c.volts = 10.9f; return c; }
  if (t < 300) driveStart = 42;
  else if (t < 350) { c.volts = offVolts(t - 300); return c; }
  else if (t < 352) { c.volts = 10.9f; return c; }
  else if (t < 480) driveStart = 352;
  else { c.volts = offVolts(t - 480); return c; }

  c.engine = true;
  c.driveS = t - driveStart;
  c.volts = (t >= 150 && t < 200) ? 12.6f : 14.2f;
  // Speed: 10 s at idle, then a 60 s triangle between 0 and 100 km/h.
  float d = c.driveS - 10;
  if (d > 0) {
    float tri = fmodf(d, 60.0f) / 30.0f;  // 0..2
    c.kph = (uint8_t)(100.0f * (tri < 1 ? tri : 2 - tri));
  }
  c.rpm = c.kph ? 1200 + c.kph * 15 : 750;
  return c;
}

// Supported-PID bitmask for the range that starts at base (0x00, 0x20, ...), built from
// the PIDs this fake answers. Bit 31 is PID base+1, bit 0 says the next range exists.
static uint32_t maskFor(uint8_t base) {
  static const uint8_t pids[] = {0x05, 0x0C, 0x0D, 0x0F, 0x10, 0x11, 0x2F, 0x42, 0xA6};
  uint32_t m = base < 0xA0 ? 1 : 0;
  for (uint8_t p : pids) {
    if (p > base && p <= base + 0x20) m |= 0x80000000u >> (p - base - 1);
  }
  return m;
}

static String hexReply(uint8_t pid, uint32_t value, int nbytes) {
  char b[16];
  snprintf(b, sizeof(b), "41%02X%0*lX", pid, nbytes * 2, (unsigned long)value);
  return String(b);
}

static String mode01(const String& c, const Car& car) {
  uint8_t pid = (uint8_t)strtoul(c.substring(2, 4).c_str(), nullptr, 16);
  if (!car.engine) {
    // The real car is silent with the engine off. During a protocol search that takes longer.
    vTaskDelay(pdMS_TO_TICKS(s_searching ? 3000 : 200));
    return s_searching ? String("SEARCHING...\nUNABLE TO CONNECT") : String("NO DATA");
  }
  vTaskDelay(pdMS_TO_TICKS(40));
  if (pid % 0x20 == 0 && pid <= 0xA0) return hexReply(pid, maskFor(pid), 4);
  float warm = car.driveS > 120 ? 1.0f : car.driveS / 120.0f;
  switch (pid) {
    case 0x0C: return hexReply(pid, car.rpm * 4u, 2);
    case 0x0D: return car.driveS < 10 ? String("NO DATA") : hexReply(pid, car.kph, 1);
    case 0x10: return hexReply(pid, (uint32_t)((3.0f + car.kph * 0.25f) * 100), 2);
    case 0x11: return hexReply(pid, (uint32_t)((12 + car.kph / 3) * 255 / 100), 1);
    case 0x05: return hexReply(pid, (uint32_t)(40 + 30 + 60 * warm), 1);  // 30 C warming to 90 C
    case 0x0F: return hexReply(pid, 40 + 25, 1);
    case 0x2F: return hexReply(pid, 191, 1);                              // 74.9 %
    case 0x42: return hexReply(pid, (uint32_t)(car.volts * 1000) - 130, 2);
    case 0xA6: return hexReply(pid, (uint32_t)(s_odoKm * 10), 4);
  }
  return String("NO DATA");
}

bool begin() {
  Serial.println("[bench] scripted adapter, no Bluetooth. Car script: 10 min cycle of parked on a charger, start, drive, stop, restart");
  Serial.println("[bench] expect one protocol search about 15 s after the adapter connects, and none after that");
  Serial.println("[bench] expect speed to be skipped at the start of each drive and back within 20 s");
  return true;
}

bool connect(uint32_t) {
  vTaskDelay(pdMS_TO_TICKS(500));
  if (!s_t0) s_t0 = s_lastMs = millis();
  s_connected = true;
  Serial.println("[bench] adapter connected");
  return true;
}

bool connected() { return s_connected; }
void disconnect() { s_connected = false; }
void forgetBonds() { Serial.println("[bench] no pairings in the bench build"); }

String cmd(const char* c, uint32_t) {
  if (!s_connected) return String();
  uint32_t now = millis();
  Car car = carAt(now);
  s_odoKm += car.kph * ((now - s_lastMs) / 3600000.0);
  s_lastMs = now;

  String s(c);
  s.toUpperCase();
  if (s.startsWith("01")) return mode01(s, car);
  vTaskDelay(pdMS_TO_TICKS(25));
  if (s == "ATRV") {
    char b[12];
    snprintf(b, sizeof(b), "%.1fV", car.volts);
    return String(b);
  }
  if (s == "ATZ") return String("ELM327 v1.4b");
  if (s == "STI") return String("STN2255 v5.7.0 (bench)");
  if (s == "ATDPN") return String("A7");
  if (s.startsWith("ATSP")) { s_searching = s == "ATSP0"; return String("OK"); }
  if (s.startsWith("AT")) return String("OK");
  return String("?");
}

char protocol() { return OBD_PROTOCOL[0]; }
void setProtocol(char) {}

bool initElm() {
  Serial.printf("[obd] ATZ -> %s\n", cmd("ATZ", OBD_INIT_TIMEOUT_MS).c_str());
  Serial.printf("[obd] ATRV -> %s\n", cmd("ATRV", OBD_CMD_TIMEOUT_MS).c_str());
  return true;
}

}  // namespace obd
#endif  // BENCH
