#include "storage.h"
#include <LittleFS.h>
#include <sys/stat.h>
#include "config.h"
#include "seg_queue.h"

// The queue's rules live in include/seg_queue.h, where the host tests can run them. This
// file gives that logic the LittleFS calls, one mutex around everything, and the log lines.
namespace storage {

static const char* kMount = "/littlefs";  // LittleFS mount point. stat() needs the full path.

// The bench build stores scripted records: a made-up drive, position and odometer. They
// go to a folder of their own, so a normal build flashed onto the same board later can
// never find them and upload them as a real drive.
#if BENCH
#define QUEUE_DIR "/qbench"
#else
#define QUEUE_DIR "/q"
#endif

static String segPath(uint32_t n) {
  char p[24];  // "/qbench/4294967295.bin" is 22 characters
  snprintf(p, sizeof(p), QUEUE_DIR "/%08lu.bin", (unsigned long)n);
  return String(p);
}

struct LittleFsSegments : segq::Fs {
  File cur;

  // Reads the directory only. Opening every file here made each upload cycle slower as
  // the queue grew, with the writer waiting on the same mutex.
  std::vector<uint32_t> list() override {
    std::vector<uint32_t> v;
    File d = LittleFS.open(QUEUE_DIR);
    if (!d) return v;
    for (String path = d.getNextFileName(); path.length(); path = d.getNextFileName()) {
      const char* name = path.c_str() + path.lastIndexOf('/') + 1;  // "/q/00000042.bin"
      uint32_t n = strtoul(name, nullptr, 10);
      if (n) v.push_back(n);
    }
    return v;
  }

  // The committed size, without opening the file.
  long sizeOf(uint32_t n) override {
    struct stat st;
    String p = String(kMount) + segPath(n);
    return stat(p.c_str(), &st) == 0 ? (long)st.st_size : -1;
  }

  bool openForAppend(uint32_t n) override {
    cur = LittleFS.open(segPath(n), FILE_APPEND, true);
    return (bool)cur;
  }

  bool write(const uint8_t* p, size_t n) override { return cur.write(p, n) == n; }
  void flush() override { cur.flush(); }
  void close() override { cur.close(); }

  size_t read(uint32_t n, size_t off, uint8_t* buf, size_t len) override {
    File f = LittleFS.open(segPath(n));
    if (!f) return 0;
    if (off && !f.seek(off)) return 0;
    return f.read(buf, len);
  }

  bool remove(uint32_t n) override { return LittleFS.remove(segPath(n)); }
  size_t usedBytes() override { return LittleFS.usedBytes(); }
};

static SemaphoreHandle_t s_mtx;
static bool s_ok = false;  // false = no filesystem, records are dropped (logged once)
static LittleFsSegments s_fs;
static segq::Queue s_q(s_fs);
static uint32_t s_noFs = 0;  // records dropped because there is no filesystem
static size_t s_fsTotal = 0;

struct Lock {
  Lock() { xSemaphoreTake(s_mtx, portMAX_DELAY); }
  ~Lock() { xSemaphoreGive(s_mtx); }
};

// Says what the queue just did, by comparing its counters with their values before the call.
struct Report {
  uint32_t lost = s_q.lostWrites(), capped = s_q.capSegments(), noFile = s_q.openFailures();
  uint32_t unread = s_q.unreadable(), gaveUp = s_q.lostSegments(), stuck = s_q.stuckSegments();
  ~Report() {
    if (s_q.lostSegments() != gaveUp) {
      Serial.printf("[fs] a segment could not be read in %u tries and is skipped, %lu records counted as dropped\n",
                    (unsigned)segq::kReadTries + 1, (unsigned long)(s_q.unreadable() - unread));
    }
    if (s_q.stuckSegments() != stuck) {
      Serial.println("[fs] an uploaded segment could not be deleted. It will not be sent again");
    }
    if (s_q.lostWrites() != lost) {
      Serial.printf("[fs] write failed, %lu records lost (%lu since boot)\n", (unsigned long)(s_q.lostWrites() - lost),
                    (unsigned long)s_q.lostWrites());
    }
    if (s_q.capSegments() != capped) {
      Serial.printf("[fs] flash over %d%% full, deleted the %lu oldest segments (%lu records dropped since boot)\n",
                    QUEUE_MAX_PCT, (unsigned long)(s_q.capSegments() - capped), (unsigned long)s_q.dropped());
    }
    // Once a minute at 1 Hz is enough.
    if (s_q.openFailures() != noFile && noFile % 60 == 0) {
      Serial.println("[fs] cannot open a segment file, records are being dropped");
    }
  }
};

bool begin() {
  s_mtx = xSemaphoreCreateMutex();
  // A fresh board still holds the factory firmware's data in this partition, which
  // LittleFS reports as a corrupted dir pair. begin(true) does not always recover from
  // that, so format explicitly and retry.
  if (!LittleFS.begin(false, kMount)) {
    Serial.println("[fs] mount failed, formatting partition (normal on first boot)");
    if (!LittleFS.format() || !LittleFS.begin(false, kMount)) {
      Serial.println("[fs] format failed, running without flash buffering");
      return false;
    }
  }
  s_ok = true;
  LittleFS.mkdir(QUEUE_DIR);
  s_fsTotal = LittleFS.totalBytes();
  segq::Config cfg;
  cfg.recBytes = sizeof(Record);
  cfg.segRecords = MAX_UPLOAD_BYTES / sizeof(Record);  // 341, one upload body
  cfg.flushEvery = FLUSH_EVERY;
  cfg.capBytes = s_fsTotal / 100 * QUEUE_MAX_PCT;
  {
    Report rep;
    s_q.begin(cfg);
  }
  Stats st = stats();
  Serial.printf("[fs] %u segments waiting, %u bytes, flash %u of %u bytes used, writing seg %lu\n",
                (unsigned)(st.segments ? st.segments - 1 : 0), (unsigned)st.bytes, (unsigned)st.fsUsed,
                (unsigned)st.fsTotal, (unsigned long)s_q.curSeg());
  return true;
}

void append(const Record& r, bool flushNow) {
  Lock l;
  if (!s_ok) { s_noFs++; return; }
  Report rep;
  s_q.append(reinterpret_cast<const uint8_t*>(&r), flushNow);
}

bool rotate() {
  Lock l;
  if (!s_ok) return false;
  Report rep;
  return s_q.rotate();
}

size_t readBatch(uint8_t* buf, size_t cap, uint32_t& lastSeg, bool& retrying) {
  lastSeg = 0;
  retrying = false;
  Lock l;
  if (!s_ok) return 0;
  Report rep;
  return s_q.readBatch(buf, cap, lastSeg, retrying);
}

void ack(uint32_t lastSeg) {
  Lock l;
  if (!s_ok) return;
  Report rep;
  s_q.ack(lastSeg);
}

Stats stats() {
  Lock l;
  Stats s = {};
  s.dropped = s_noFs + s_q.dropped();
  if (!s_ok) return s;
  s_q.count(s.segments, s.bytes);
  s.fsUsed = LittleFS.usedBytes();
  s.fsTotal = s_fsTotal;
  return s;
}

}  // namespace storage
