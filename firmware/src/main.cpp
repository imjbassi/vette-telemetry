#include <Arduino.h>
#include <Preferences.h>
#include "config.h"
#include "record.h"
#include "engine_gate.h"
#include "net_policy.h"
#include "obd_ble.h"
#include "pids.h"
#include "storage.h"
#include "net.h"
#if BENCH
#include "bench.h"
#endif

static uint16_t g_boot = 0;
static uint8_t g_inst = 0;  // install id, byte 44 of every record
// Written by the OBD loop, read by the net task. Uploads slow down while not active.
static volatile bool g_activeMode = false;

// ---------------------------------------------------------------- net task
static uint8_t s_upBuf[MAX_UPLOAD_BYTES];
// How large an upload may be and how long to wait after a refusal. See net_policy.h.
// Changed by the net task only. The console reads it for the "s" printout.
static netpol::UploadPolicy s_upPolicy(MAX_UPLOAD_BYTES, UPLOAD_FALLBACK_BYTES, UPLOAD_PERIOD_MS * 2, UPLOAD_MAX_WAIT_MS);
static_assert(UPLOAD_FALLBACK_BYTES % sizeof(Record) == 0 && UPLOAD_FALLBACK_BYTES <= MAX_UPLOAD_BYTES,
              "the fallback body is whole records and fits the buffer");

// One upload pass: at most UPLOAD_MAX_POSTS uploads, so GNSS, signal and clock keep
// being read during a long backlog. Returns the last HTTP status, or 0 when nothing was
// sent. more is set when the pass stopped at its limit and data may still be waiting.
static int uploadPass(bool& more) {
  more = false;
  int code = 0;
  int posts = 0;
  bool rotated = false;
  while (posts < UPLOAD_MAX_POSTS) {
    uint32_t lastSeg;
    bool retrying;
    size_t n = storage::readBatch(s_upBuf, s_upPolicy.bodyCap(), lastSeg, retrying);
    if (n == 0) {
      // The oldest segment could not be read just now. The next pass tries it again.
      // A second try in this pass would use up its tries twice as fast, and closing the
      // open segment for it would leave one small file per pass.
      if (retrying) return code;
      // No closed segment is waiting. Only now close the open one, so that failing
      // uploads cannot pile up one small file per try.
      if (rotated || !storage::rotate()) return code;
      rotated = true;
      continue;
    }
    posts++;
    uint32_t t0 = millis();
    code = net::post(s_upBuf, n);
    Serial.printf("[up] %u bytes (%u recs) -> %d in %lums\n", (unsigned)n, (unsigned)(n / sizeof(Record)), code,
                  (unsigned long)(millis() - t0));
    if (s_upPolicy.onPost(n, code)) {
      Serial.printf("[up] %u large uploads in a row were refused, sending %u records at a time until the next boot\n",
                    (unsigned)netpol::kBodyRefusals, (unsigned)(UPLOAD_FALLBACK_BYTES / sizeof(Record)));
    }
    if (code < 200 || code >= 300) return code;  // keep data, retry later
    storage::ack(lastSeg);
    net::service();  // a backlog must not starve GNSS, signal and clock readings
    if (retrying) return code;  // a segment behind this batch failed its read. It waits for the next pass.
  }
  more = true;
  return code;
}

static void netTask(void*) {
  bool up = false, tried = false, checked = false, more = false;
  uint32_t lastBegin = 0, lastUpload = 0;
  for (;;) {
    if (!up && (!tried || millis() - lastBegin >= NET_BEGIN_RETRY_MS)) {
      // A modem that was slow to start must not cost the whole drive. Keep trying.
      tried = true;
      lastBegin = millis();
      up = net::begin();
    }
    if (up) {
      net::service();
      if (!checked && net::ready()) {
        checked = true;
        int code = net::checkBackend();
        Serial.printf("[up] backend %s (HTTP %d)\n", code == 200 ? "reachable" : "NOT reachable", code);
      }
      // Parked, the heartbeat records are in no hurry and every upload costs a TLS handshake.
      uint32_t period = g_activeMode ? UPLOAD_PERIOD_MS : UPLOAD_IDLE_PERIOD_MS;
      // After HTTP 400 to 599 the policy asks for a longer wait, twice as long after each
      // refusal. Any accepted upload ends it.
      if (s_upPolicy.waitMs() > period) period = s_upPolicy.waitMs();
      if (net::ready() && (more || millis() - lastUpload > period)) {
        lastUpload = millis();
        int code = uploadPass(more);
        if (code >= 400 && code <= 599) {
          lastUpload = millis();  // the wait counts from the refusal
          Serial.printf("[up] HTTP %d, next try in %lu s\n", code, (unsigned long)(s_upPolicy.waitMs() / 1000));
        }
      }
    }
    vTaskDelay(pdMS_TO_TICKS(250));
  }
}

// ---------------------------------------------------------------- OBD side
enum class Link { Down, Up };
static Link s_link = Link::Down;
static uint32_t s_backoffMs = 2000;
static gate::EngineGate s_gate;  // quiet or active, and when to probe. See engine_gate.h
static uint32_t s_lastTick = 0;
static uint32_t s_cycle = 0;
static uint8_t s_atrvFails = 0;

// Device-side trip accumulators (for serial readout; the backend computes its own).
static double s_tripMiles = 0, s_tripGal = 0;

static void fillCommon(Record& r) {
  r.boot = g_boot;
  r.inst = g_inst;
  r.fw = FW_BUILD;
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
  // Quiet until a probe finds a running engine. The first connect, and a reconnect after
  // a link lost while active, probe on the first tick. A reconnect while already quiet
  // carries on with the quiet period it had.
  s_gate.onConnect(millis());
  s_atrvFails = 0;
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
  if (has(V_ODO)) s += String("  odo ") + String(r.odo_hm * 0.0621371, 1) + "mi";  // 0.1 km units
  if (has(V_SPEED) && has(V_MAF)) s += String("  mpg ") + String(pids::instantMpg(maf, r.speed_kph), 1);
  Serial.printf("%s  trip %.2fmi %.3fgal  gps %d\n", s.c_str(), s_tripMiles, s_tripGal,
                (r.valid & V_GPS) ? r.sats : -1);
}

static void tick() {
  uint32_t now = millis();
  uint32_t period = s_gate.active() ? POLL_PERIOD_MS : QUIET_TICK_MS;
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
  int mv = (int)lroundf(v * 1000);

  // Battery guard. ATRV is answered by the adapter and creates no CAN traffic, so it runs
  // always. The car itself is asked for RPM only, and only when the gate's schedule says
  // so. An RPM reply above zero is the one thing that starts polling. Voltage cannot
  // decide it: a running engine can sit near 12 V and a charger can hold 13 V.
  if (!s_gate.active() && s_gate.wantProbe(now, mv)) {
    uint16_t rpm = 0;
    gate::Probe res = !pids::engineRpm(rpm) ? gate::Probe::NoReply : rpm > 0 ? gate::Probe::Running : gate::Probe::Stopped;
    s_gate.onProbe(now, res, mv);
    if (s_gate.active()) {
      Serial.printf("[obd] %.2fV engine running (rpm %u), polling\n", v, rpm);
      pids::probe();  // which PIDs the ECU supports. Asked only now that it is awake.
      s_cycle = 0;    // read the slow PIDs on the first pass
    } else {
      Serial.printf("[obd] %.2fV probe %u: %s\n", v, s_gate.probes() + s_gate.extraProbes(),
                    res == gate::Probe::Stopped ? "rpm 0" : "no reply");
      if (s_gate.wantSearch()) pids::searchProtocol();
    }
  }

  if (s_gate.active()) {
    pids::pollFast(r);
    bool hasRpm = (r.valid & V_RPM) != 0;
    // The slow PIDs are asked only in a tick that has RPM. A tick without RPM asked at
    // most the fast PIDs (see pollFast), and the slow round waits for the next tick with RPM.
    if (hasRpm && s_cycle++ % SLOW_EVERY_N == 0) pids::pollSlow(r);
    else pids::carrySlow(r);
    bool running = hasRpm && r.rpm > 0;
    // Also set for up to 3 s after the last RPM above zero when this reply is missing.
    // One lost reply on the newest record would otherwise show a moving car as parked.
    if (s_gate.engineOn(now, hasRpm ? (int)r.rpm : -1)) r.flags |= F_ENGINE_ON;
    s_gate.onPoll(now, running);
    if (!s_gate.active()) Serial.printf("[obd] %.2fV no RPM for %u s, going quiet\n", v, (unsigned)(gate::kOffGraceMs / 1000));
  } else {
    // Parked heartbeat: one record on entering quiet, then one every 30 s. It carries the
    // adapter voltage and what fillCommon() adds. Old fuel, odometer and ECU voltage
    // values are not copied in, they would look like fresh readings.
    g_activeMode = false;
    if (!s_gate.wantQuietRecord(now)) return;
    r.flags |= F_QUIET;
  }
  g_activeMode = s_gate.active();
  fillCommon(r);
  record_seal(r);
  // A quiet record is flushed at once. The next one is 30 s away and power may be gone by then.
  storage::append(r, (r.flags & F_QUIET) != 0);
#if BENCH
  bench::onStored(r);
#endif

  float maf = r.maf_cgs / 100.0f;
  if ((r.valid & V_SPEED) && (r.valid & V_MAF) && dt > 0 && dt < 5) {
    s_tripMiles += r.speed_kph * 0.621371 * dt / 3600.0;
    s_tripGal += pids::gallonsFromMaf(maf, dt);
  }
  printLine(r, v);
}

// Serial console. ">010C" sends a raw command to the adapter (handy for Mode 22 research).
// "q" prints the flash queue, "s" prints identity, engine gate and network state,
// "unpair" erases the stored pairings.
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
      storage::Stats st = storage::stats();
      Serial.printf("[fs] %u segments, %u bytes waiting, %u records dropped since boot, flash %u of %u bytes used\n",
                    (unsigned)st.segments, (unsigned)st.bytes, (unsigned)st.dropped, (unsigned)st.fsUsed,
                    (unsigned)st.fsTotal);
    } else if (line == "s") {
      Serial.printf("[id] fw %u, inst %u, boot %u, session %lu\n", (unsigned)FW_BUILD, g_inst, g_boot,
                    (unsigned long)g_inst * 65536UL + g_boot);
      Serial.printf("[gate] link %s, %s, %u probes this quiet period (%u past the cap), protocol search %s\n",
                    s_link == Link::Up ? "up" : "down", s_gate.active() ? "active" : "quiet",
                    s_gate.probes() + s_gate.extraProbes(), s_gate.extraProbes(),
                    s_gate.searched() ? "used" : "not used");
      net::Fix f = net::fix();
      Serial.printf("[net] data link %s, signal %u, gps %s (%u sats), epochBase %lu\n", net::ready() ? "up" : "down",
                    net::csq(), f.valid ? "fix" : "no fix", f.sats, (unsigned long)net::epochBase());
      Serial.printf("[up] uploads of up to %u records, %lu s extra wait after a refusal\n",
                    (unsigned)(s_upPolicy.bodyCap() / sizeof(Record)), (unsigned long)(s_upPolicy.waitMs() / 1000));
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
  g_inst = p.getUChar("inst", 0);
  if (g_inst == 0) {
    // Drawn once per board, and again after a full flash erase. With the boot counter it
    // keeps this board's sessions apart from another board's, or from its own old ones
    // after the counter restarted. Never 0: that marks firmware from before this byte.
    g_inst = (uint8_t)((esp_random() ^ (uint32_t)ESP.getEfuseMac() ^ micros()) % 255 + 1);
    p.putUChar("inst", g_inst);
  }
  p.end();
  Serial.printf("\n[boot] vette-telemetry fw %u, inst %u, boot #%u\n", (unsigned)FW_BUILD, g_inst, g_boot);

  storage::begin();
  obd::begin();
  xTaskCreatePinnedToCore(netTask, "net", 8192, nullptr, 1, nullptr, 0);
}

void loop() {
  console();
  if (s_link == Link::Up && !obd::connected()) {
    s_link = Link::Down;
    g_activeMode = false;
    Serial.println("[obd] link lost");
  }
  if (s_link == Link::Down) tryConnect();
  else tick();
  delay(10);
}
