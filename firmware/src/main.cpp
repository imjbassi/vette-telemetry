#include <Arduino.h>
#include <Preferences.h>
#include "config.h"
#include "record.h"
#include "obd_ble.h"
#include "pids.h"
#include "storage.h"
#include "net.h"

static uint16_t g_boot = 0;

// ---------------------------------------------------------------- net task
static uint8_t s_upBuf[MAX_UPLOAD_BYTES];

static void uploadAll() {
  storage::rotate();
  for (int i = 0; i < 20; i++) {  // bounded so GNSS/CSQ servicing keeps running
    uint32_t lastSeg;
    size_t n = storage::readBatch(s_upBuf, sizeof(s_upBuf), lastSeg);
    if (n == 0) return;
    uint32_t t0 = millis();
    int code = net::post(s_upBuf, n);
    Serial.printf("[up] %u bytes (%u recs) -> %d in %lums\n", (unsigned)n, (unsigned)(n / sizeof(Record)), code,
                  (unsigned long)(millis() - t0));
    if (code < 200 || code >= 300) return;  // keep data, retry next period
    storage::ack(lastSeg);
  }
}

static void netTask(void*) {
  bool up = net::begin();
  uint32_t lastUpload = 0;
  for (;;) {
    if (up) {
      net::service();
      if (net::ready() && millis() - lastUpload > UPLOAD_PERIOD_MS) {
        lastUpload = millis();
        uploadAll();
      }
    }
    vTaskDelay(pdMS_TO_TICKS(250));
  }
}

// ---------------------------------------------------------------- OBD side
enum class Link { Down, Up };
static Link s_link = Link::Down;
static uint32_t s_backoffMs = 2000;
static bool s_quiet = true;        // quiet = adapter-only traffic, nothing sent to the car
static uint32_t s_lastOnMs = 0;    // last time the engine was seen running or charging
static uint32_t s_lastProbeMs = 0; // last ECU probe while quiet. 0 = probe on next tick
static uint32_t s_lastTick = 0;
static uint32_t s_cycle = 0;
static uint8_t s_atrvFails = 0;

// Device-side trip accumulators (for serial readout; the backend computes its own).
static double s_tripMiles = 0, s_tripGal = 0;

static void fillCommon(Record& r) {
  r.boot = g_boot;
  r.ms = millis();
  uint32_t base = net::epochBase();
  r.epoch = base ? base + r.ms / 1000 : 0;
  net::Fix f = net::fix();
  if (f.valid) { r.lat_e7 = f.lat_e7; r.lon_e7 = f.lon_e7; r.sats = f.sats; r.valid |= V_GPS; }
  uint8_t q = net::csq();
  if (q != 99) { r.csq = q; r.valid |= V_CSQ; }
}

static void tryConnect() {
  if (!obd::connect(5)) {
    vTaskDelay(pdMS_TO_TICKS(s_backoffMs));
    s_backoffMs = min<uint32_t>(s_backoffMs * 2, 30000);
    return;
  }
  s_backoffMs = 2000;
  if (!obd::initElm()) {
    Serial.println("[obd] adapter did not answer setup commands, reconnecting");
    obd::disconnect();
    return;
  }
  pids::reset();
  s_link = Link::Up;
  s_quiet = true;       // start quiet. The first tick decides whether the engine is running.
  s_lastProbeMs = 0;
  s_atrvFails = 0;
}

static void goActive(float v, const char* why) {
  Serial.printf("[obd] %.2fV %s, polling\n", v, why);
  s_quiet = false;
  s_lastOnMs = millis();
  s_cycle = 0;  // read the slow PIDs on the first pass
}

static void printLine(const Record& r, float v) {
  if (r.flags & F_QUIET) {
    Serial.printf("quiet  %.2fV  (engine off, not querying the car)\n", v);
    return;
  }
  auto has = [&](uint16_t bit) { return (r.valid & bit) != 0; };
  float maf = r.maf_cgs / 100.0f;
  String s;
  s += has(V_RPM) ? String("rpm ") + r.rpm : String("rpm --");
  s += has(V_SPEED) ? String("  ") + r.speed_kph + " kph" : String("  -- kph");
  s += has(V_COOLANT) ? String("  ect ") + String(r.coolant_dc / 10.0, 0) + "C" : String("  ect --");
  s += has(V_INTAKE) ? String("  iat ") + String(r.intake_dc / 10.0, 0) + "C" : String("  iat --");
  s += has(V_MAF) ? String("  maf ") + String(maf, 2) : String("  maf --");
  s += has(V_THROTTLE) ? String("  thr ") + r.throttle_pct + "%" : String("  thr --");
  s += has(V_FUEL) ? String("  fuel ") + String(r.fuel_raw * 100.0 / 255.0, 1) + "%" : String("  fuel --");
  s += String("  ") + String(v, 2) + "V";
  if (has(V_SPEED) && has(V_MAF)) s += String("  mpg ") + String(pids::instantMpg(maf, r.speed_kph), 1);
  Serial.printf("%s  trip %.2fmi %.3fgal  gps %d\n", s.c_str(), s_tripMiles, s_tripGal,
                (r.valid & V_GPS) ? r.sats : -1);
}

static void tick() {
  uint32_t now = millis();
  uint32_t period = s_quiet ? QUIET_TICK_MS : POLL_PERIOD_MS;
  if (now - s_lastTick < period) return;
  float dt = s_lastTick ? (now - s_lastTick) / 1000.0f : 0;
  s_lastTick = now;

  Record r = {};
  float v = pids::adapterVolts();
  if (isnan(v)) {
    if (++s_atrvFails >= 5) { Serial.println("[obd] adapter unresponsive, reconnecting"); obd::disconnect(); }
    return;
  }
  s_atrvFails = 0;
  r.adapter_mv = (uint16_t)(v * 1000);
  r.valid |= V_ADAPTER_V;

  // Battery guard. ATRV is answered by the adapter and creates no CAN traffic, so it runs
  // always. The car is only queried while the engine runs. Voltage alone cannot decide
  // that: GM's charging control lets the alternator drop below 13 V while cruising. So
  // charging voltage wakes us up, and RPM keeps us awake.
  bool charging = v >= ENGINE_ON_VOLTS;
  if (s_quiet) {
    uint32_t every = charging ? CHARGING_PROBE_MS : QUIET_RPM_PROBE_MS;
    if (s_lastProbeMs == 0 || now - s_lastProbeMs >= every) {
      s_lastProbeMs = now;
      uint16_t rpm = 0;
      if (charging) {
        if (pids::probe(true)) goActive(v, "charging and ECU answering");
      } else if (pids::engineRpm(rpm) && rpm > 0 && pids::probe(false)) {
        goActive(v, "engine running");
      }
    }
  }

  if (!s_quiet) {
    pids::pollFast(r);
    if (s_cycle++ % SLOW_EVERY_N == 0) pids::pollSlow(r);
    else pids::carrySlow(r);
    bool running = (r.valid & V_RPM) && r.rpm > 0;
    if (running || charging) {
      s_lastOnMs = now;
      r.flags |= F_ENGINE_ON;
    } else if (now - s_lastOnMs > ENGINE_OFF_GRACE_MS) {
      Serial.printf("[obd] %.2fV no RPM and not charging, going quiet\n", v);
      s_quiet = true;
      s_lastProbeMs = now;
    }
  } else {
    pids::carrySlow(r);
    r.flags |= F_QUIET;
  }
  fillCommon(r);
  record_seal(r);
  storage::append(r);

  float maf = r.maf_cgs / 100.0f;
  if ((r.valid & V_SPEED) && (r.valid & V_MAF) && dt > 0 && dt < 5) {
    s_tripMiles += r.speed_kph * 0.621371 * dt / 3600.0;
    s_tripGal += pids::gallonsFromMaf(maf, dt);
  }
  printLine(r, v);
}

// Serial console. ">010C" sends a raw command to the adapter (handy for Mode 22 research).
// "q" prints queue size.
static void console() {
  static String line;
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c != '\n' && c != '\r') { line += c; continue; }
    line.trim();
    if (line.startsWith(">")) {
      String rsp = obd::cmd(line.substring(1).c_str(), 5000);
      Serial.printf("[raw] %s -> %s\n", line.c_str() + 1, rsp.c_str());
    } else if (line == "unpair") {
      obd::forgetBonds();
    } else if (line == "q") {
      Serial.printf("[fs] pending %u bytes, epochBase %lu\n", (unsigned)storage::pendingBytes(),
                    (unsigned long)net::epochBase());
    }
    line = "";
  }
}

void setup() {
  Serial.begin(115200);
  delay(1500);

  Preferences p;
  p.begin("vette", false);
  g_boot = p.getUShort("boot", 0) + 1;
  p.putUShort("boot", g_boot);
  p.end();
  Serial.printf("\n[boot] vette-telemetry boot #%u\n", g_boot);

  storage::begin();
  obd::begin();
  xTaskCreatePinnedToCore(netTask, "net", 8192, nullptr, 1, nullptr, 0);
}

void loop() {
  console();
  if (s_link == Link::Up && !obd::connected()) {
    s_link = Link::Down;
    Serial.println("[obd] link lost");
  }
  if (s_link == Link::Down) tryConnect();
  else tick();
  delay(10);
}
