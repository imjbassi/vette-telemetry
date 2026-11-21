// Desk build (env atoms3-bench): a scripted network in place of WiFi and the modem.
// Nothing leaves the board and no radio is touched. The link is down for a scripted
// stretch, then the "server" refuses uploads for a while, then it accepts them and
// checks every record against the list of records main.cpp stored. From the second
// round on it also refuses every large upload, so the fallback to small ones must work.
#include "config.h"
#if BENCH
#if HAS_WIFI || HAS_MODEM
#error "the bench build needs HAS_WIFI=0 and HAS_MODEM=0"
#endif
#include "net_common.h"
#include "bench.h"
#include "storage.h"

namespace bench {

// ms stamps of this boot's records that were stored and have not arrived yet, oldest
// first. 4096 entries cover more than an hour of 1 Hz records, the script needs 17 min.
static const uint32_t kListCap = 4096;
static uint32_t s_ms[kListCap];
static uint32_t s_head = 0, s_count = 0;
static uint16_t s_boot = 0;
static bool s_overflow = false;
static portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;

void onStored(const Record& r) {
  portENTER_CRITICAL(&s_mux);
  s_boot = r.boot;
  if (s_count == kListCap) {
    s_head = (s_head + 1) % kListCap;
    s_count--;
    s_overflow = true;
  }
  s_ms[(s_head + s_count) % kListCap] = r.ms;
  s_count++;
  portEXIT_CRITICAL(&s_mux);
}

// One record arrived. Returns how many older records were skipped to reach it (holes),
// or -1 when it is not in the list at all (a duplicate).
static int arrived(uint32_t ms) {
  int holes = -1;
  portENTER_CRITICAL(&s_mux);
  uint32_t i = 0;
  while (i < s_count && s_ms[(s_head + i) % kListCap] != ms) i++;
  if (i < s_count) {
    holes = (int)i;
    s_head = (s_head + i + 1) % kListCap;
    s_count -= i + 1;
  }
  portEXIT_CRITICAL(&s_mux);
  return holes;
}

}  // namespace bench

namespace net {

// The script, counted from the first successful begin(). It repeats every 22 minutes.
static const uint32_t kUpFirstMs = 60000;       //  0:00  up, uploads accepted
static const uint32_t kDownMs = 15 * 60000;     //  1:00  no data link for 15 minutes
static const uint32_t kRefuseMs = 80000;        // 16:00  link up, every upload gets HTTP 503
static const uint32_t kUpAgainMs = 280000;      // 17:20  up, the backlog drains
static const uint32_t kRoundMs = kUpFirstMs + kDownMs + kRefuseMs + kUpAgainMs;
enum class Phase { Up, Down, Refusing };

static bool s_begun = false;
static uint32_t s_t0 = 0;
static Phase s_phase = Phase::Up;

// Counters since the last verdict line.
static uint32_t s_good, s_holes, s_dups, s_bad, s_torn, s_otherBoot, s_posts, s_refused;
static uint32_t s_drainNo = 0;
static uint32_t s_droppedSeen = 0;
static bool s_draining = false;   // a verdict is owed for the current up phase
static bool s_afterPost = false;  // an upload was accepted since the last service()

static Phase phaseNow() {
  uint32_t t = (millis() - s_t0) % kRoundMs;
  if (t < kUpFirstMs) return Phase::Up;
  if (t < kUpFirstMs + kDownMs) return Phase::Down;
  if (t < kUpFirstMs + kDownMs + kRefuseMs) return Phase::Refusing;
  return Phase::Up;
}

// The first round drains its backlog in full-size uploads. From the second round on the
// "server" answers 503 to every body over the fallback size, the way a modem or Worker
// limit on large uploads would. The upload loop must switch to small uploads after
// three refusals and still drain everything.
static bool refusesLargeBodies() { return millis() - s_t0 >= kRoundMs; }

bool begin() {
  static bool failedOnce = false;
  if (!failedOnce) {
    failedOnce = true;
    Serial.println("[bench] net: first bring-up fails on purpose. A retry must follow in 30 s");
    return false;
  }
  s_begun = true;
  s_t0 = millis();
  s_draining = true;
  Serial.println("[bench] net: up. Script: 1 min up, 15 min down, 80 s of HTTP 503, 4 min 40 s up, repeat");
  Serial.printf("[bench] net: from the second round on, uploads over %u bytes get HTTP 503 as well\n",
                (unsigned)UPLOAD_FALLBACK_BYTES);
  return true;
}

bool ready() { return s_begun && phaseNow() != Phase::Down; }

static void verdict(const storage::Stats& st) {
  bool lostInQueue = st.dropped != s_droppedSeen;
  s_droppedSeen = st.dropped;
  bool pass = !s_holes && !s_dups && !s_bad && !s_torn && !bench::s_overflow && !lostInQueue;
  Serial.printf("[bench] drain %lu %s: %lu records in %lu uploads, %lu holes, %lu duplicates, %lu bad, "
                "%lu refused uploads, %lu from earlier boots%s%s\n",
                (unsigned long)++s_drainNo, pass ? "PASS" : "FAIL", (unsigned long)s_good, (unsigned long)s_posts,
                (unsigned long)s_holes, (unsigned long)s_dups, (unsigned long)(s_bad + s_torn),
                (unsigned long)s_refused, (unsigned long)s_otherBoot,
                bench::s_overflow ? ", CHECK LIST OVERFLOWED" : "", lostInQueue ? ", QUEUE DROPPED RECORDS" : "");
  Serial.printf("[bench] queue: %u segments, %u bytes waiting, %u records dropped since boot, flash %u of %u bytes used\n",
                (unsigned)st.segments, (unsigned)st.bytes, (unsigned)st.dropped, (unsigned)st.fsUsed,
                (unsigned)st.fsTotal);
  s_good = s_holes = s_dups = s_bad = s_torn = s_otherBoot = s_posts = s_refused = 0;
  bench::s_overflow = false;
}

void service() {
  Phase p = phaseNow();
  if (p != s_phase) {
    s_phase = p;
    Serial.printf("[bench] net: %s\n", p == Phase::Down ? "link down for 15 min"
                                       : p == Phase::Refusing ? "link up, server answers 503 for 80 s"
                                       : refusesLargeBodies() ? "up, small uploads accepted, large ones get 503"
                                                              : "up, uploads accepted");
    if (p == Phase::Up) s_draining = true;
  }
  // A fix at a public landmark, a mid-scale signal and a clock, so records look complete.
  Fix f;
  f.valid = true;
  f.lat_e7 = 378199000;
  f.lon_e7 = -1224783000;
  f.sats = 9;
  portENTER_CRITICAL(&state::mux);
  state::fix = f;
  portEXIT_CRITICAL(&state::mux);
  state::csq = p == Phase::Down ? 99 : 20;
  if (p != Phase::Down && epochBase() == 0) state::setEpochNow(1794436923);

  // The drain is over when an accepted upload leaves nothing but the open segment.
  if (s_afterPost) {
    s_afterPost = false;
    if (s_draining) {
      storage::Stats st = storage::stats();
      if (st.segments <= 1) {
        verdict(st);
        s_draining = false;
      }
    }
  }
}

int checkBackend() { return ready() ? 200 : -1; }

int post(const uint8_t* body, size_t len, const char* query) {
  if (!ready()) return -1;
  vTaskDelay(pdMS_TO_TICKS(1500));  // about what an LTE upload takes
  Phase p = phaseNow();
  if (p == Phase::Down) return -7;  // the link dropped during the upload. Nothing arrived.
  bool probe = strstr(query, "p=1") != nullptr;  // the body size test sends no records
  if (p == Phase::Refusing || (refusesLargeBodies() && len > UPLOAD_FALLBACK_BYTES)) {
    if (!probe) s_refused++;
    return 503;
  }
  if (probe) return 200;
  // What the backend would store with this upload.
  if (query[0]) Serial.printf("[bench] diag %s\n", query);

  s_posts++;
  if (len % sizeof(Record)) {
    s_torn++;
    Serial.printf("[bench] FAIL: upload of %u bytes is not a whole number of records\n", (unsigned)len);
  }
  for (size_t o = 0; o + sizeof(Record) <= len; o += sizeof(Record)) {
    Record r;
    memcpy(&r, body + o, sizeof(r));
    bool sound = r.magic == REC_MAGIC && r.version == REC_VERSION &&
                 crc16_ccitt(body + o, offsetof(Record, crc)) == r.crc;
    // Left in flash by an earlier boot or by older firmware. Sound, but not on the list.
    if (sound && (r.boot != bench::s_boot || r.fw != FW_BUILD)) { s_otherBoot++; continue; }
    if (!sound || r.inst == 0) {
      if (s_bad++ < 5) Serial.printf("[bench] FAIL: bad record at byte %u of an upload\n", (unsigned)o);
      continue;
    }
    int holes = bench::arrived(r.ms);
    if (holes < 0) {
      if (s_dups++ < 5) Serial.printf("[bench] FAIL: record ms %lu arrived twice\n", (unsigned long)r.ms);
      continue;
    }
    if (holes) Serial.printf("[bench] FAIL: %d records before ms %lu never arrived\n", holes, (unsigned long)r.ms);
    s_holes += holes;
    s_good++;
  }
  s_afterPost = true;
  return 200;
}

}  // namespace net
#endif  // BENCH
