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
static bool s_quiet = false;
static uint32_t s_lastOnMs = 0;
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
  obd::initElm();
  pids::reset();
  s_link = Link::Up;
  s_quiet = false;
  s_lastOnMs = millis();
  s_atrvFails = 0;
}

static void tick() {
  uint32_t now = millis();
  uint32_t period = s_quiet ? IDLE_PROBE_MS : POLL_PERIOD_MS;
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

  // Battery guard: only talk to ECUs while the alternator is charging. ATRV itself is
  // answered by the adapter and creates no CAN traffic.
  bool charging = v >= ENGINE_ON_VOLTS;
  if (charging) {
    s_lastOnMs = now;
    if (s_quiet) { Serial.printf("[obd] %.2fV engine on, polling\n", v); pids::reset(); }
    s_quiet = false;
  } else if (!s_quiet && now - s_lastOnMs > ENGINE_OFF_GRACE_MS) {
    Serial.printf("[obd] %.2fV engine off, going quiet\n", v);
    s_quiet = true;
  }

  if (!s_quiet) {
    pids::pollFast(r);
    if (s_cycle++ % SLOW_EVERY_N == 0) pids::pollSlow(r);
    else pids::carrySlow(r);
  } else {
    pids::carrySlow(r);
    r.flags |= F_QUIET;
  }
  if (charging) r.flags |= F_ENGINE_ON;
  fillCommon(r);
  record_seal(r);
  storage::append(r);

  float maf = r.maf_cgs / 100.0f;
  if ((r.valid & V_SPEED) && (r.valid & V_MAF) && dt > 0 && dt < 5) {
    s_tripMiles += r.speed_kph * 0.621371 * dt / 3600.0;
    s_tripGal += pids::gallonsFromMaf(maf, dt);
  }
  Serial.printf("rpm %u  %u kph  ect %.0fC  iat %.0fC  maf %.2f  thr %u%%  fuel %.1f%%  %.2fV  mpg %.1f  trip %.2fmi %.3fgal  gps %d\n",
                r.rpm, r.speed_kph, r.coolant_dc / 10.0, r.intake_dc / 10.0, maf, r.throttle_pct,
                r.fuel_raw * 100.0 / 255.0, v, pids::instantMpg(maf, r.speed_kph), s_tripMiles, s_tripGal,
                (r.valid & V_GPS) ? r.sats : -1);
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
