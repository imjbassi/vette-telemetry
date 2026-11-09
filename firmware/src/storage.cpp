#include "storage.h"
#include <LittleFS.h>
#include <vector>
#include <algorithm>
#include "config.h"

namespace storage {

static SemaphoreHandle_t s_mtx;
static File s_cur;
static uint32_t s_curSeg = 0;
static uint32_t s_unflushed = 0;

struct Lock {
  Lock() { xSemaphoreTake(s_mtx, portMAX_DELAY); }
  ~Lock() { xSemaphoreGive(s_mtx); }
};

static String segPath(uint32_t n) {
  char p[24];
  snprintf(p, sizeof(p), "/q/%08lu.bin", (unsigned long)n);
  return String(p);
}

// Sorted list of segment numbers on disk (including the open one).
static std::vector<uint32_t> listSegs() {
  std::vector<uint32_t> v;
  File d = LittleFS.open("/q");
  if (!d) return v;
  for (File f = d.openNextFile(); f; f = d.openNextFile()) {
    const char* name = f.name();  // "00000042.bin" (no dir on arduino-esp32 2.x)
    const char* slash = strrchr(name, '/');
    if (slash) name = slash + 1;
    v.push_back(strtoul(name, nullptr, 10));
  }
  std::sort(v.begin(), v.end());
  return v;
}

static void openNext() {
  s_curSeg++;
  s_cur = LittleFS.open(segPath(s_curSeg), FILE_APPEND, true);
  s_unflushed = 0;
}

static void enforceCap() {
  size_t total = 0;
  auto segs = listSegs();
  std::vector<std::pair<uint32_t, size_t>> sizes;
  for (auto n : segs) {
    File f = LittleFS.open(segPath(n));
    size_t s = f ? f.size() : 0;
    sizes.push_back({n, s});
    total += s;
  }
  for (auto& [n, s] : sizes) {
    if (total <= QUEUE_MAX_BYTES || n == s_curSeg) break;
    LittleFS.remove(segPath(n));
    total -= s;
    Serial.printf("[fs] queue full, dropped segment %lu\n", (unsigned long)n);
  }
}

bool begin() {
  s_mtx = xSemaphoreCreateMutex();
  if (!LittleFS.begin(true)) { Serial.println("[fs] mount failed"); return false; }
  LittleFS.mkdir("/q");
  auto segs = listSegs();
  s_curSeg = segs.empty() ? 0 : segs.back();
  // Never append to a segment from a previous boot. Its tail may be torn.
  openNext();
  Serial.printf("[fs] %u pending segments, %u bytes, writing seg %lu\n",
                (unsigned)segs.size(), (unsigned)pendingBytes(), (unsigned long)s_curSeg);
  return true;
}

void append(const Record& r) {
  Lock l;
  if (!s_cur) openNext();
  s_cur.write(reinterpret_cast<const uint8_t*>(&r), sizeof(r));
  if (++s_unflushed >= FLUSH_EVERY) { s_cur.flush(); s_unflushed = 0; }
}

void rotate() {
  Lock l;
  if (s_cur) {
    size_t sz = s_cur.size();
    s_cur.close();
    if (sz == 0) LittleFS.remove(segPath(s_curSeg));
  }
  openNext();
  enforceCap();
}

size_t readBatch(uint8_t* buf, size_t cap, uint32_t& lastSeg) {
  Lock l;
  size_t used = 0;
  lastSeg = 0;
  for (auto n : listSegs()) {
    if (n >= s_curSeg) break;
    File f = LittleFS.open(segPath(n));
    if (!f) continue;
    size_t sz = f.size();
    if (sz == 0) { f.close(); LittleFS.remove(segPath(n)); continue; }
    if (used + sz > cap) {
      if (used == 0) sz = cap - (cap % sizeof(Record));  // oversized: send head, rest is lost on ack
      else break;
    }
    used += f.read(buf + used, sz);
    lastSeg = n;
  }
  return used;
}

void ack(uint32_t lastSeg) {
  Lock l;
  for (auto n : listSegs()) {
    if (n > lastSeg || n >= s_curSeg) break;
    LittleFS.remove(segPath(n));
  }
}

size_t pendingBytes() {
  size_t total = 0;
  for (auto n : listSegs()) {
    File f = LittleFS.open(segPath(n));
    if (f) total += f.size();
  }
  return total;
}

}  // namespace storage
