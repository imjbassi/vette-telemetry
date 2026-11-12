// The flash queue (include/seg_queue.h) against a fake filesystem. Every record carries a
// sequence number, so the test can say exactly which records arrived, in which order,
// and which were lost. pass() is the same loop as uploadPass() in src/main.cpp.
#include <cstring>
#include <map>
#include <memory>
#include <set>
#include <vector>
#include "check.h"
#include "seg_queue.h"

static const size_t kRec = 48;
static const size_t kUpload = 16384;  // MAX_UPLOAD_BYTES
static const uint32_t kSegRecords = 341;

// Behaves like LittleFS behind the Arduino File API as far as the queue can tell: writes
// are buffered, a flush commits them or silently loses them, and the size of a file is
// what has been committed.
struct FakeFs : segq::Fs {
  std::map<uint32_t, std::vector<uint8_t>> files;  // committed bytes per segment
  uint32_t open = 0;                               // the open segment, 0 = none
  std::vector<uint8_t> pending;                    // written to it, not flushed yet
  size_t total = 1441792;                          // partition size (AtomS3)
  bool failFlush = false;                          // flushes lose their data
  bool failOpen = false;
  size_t maxRead = 0;                              // if set, a read returns at most this much
  int failReads = 0;                               // this many of the next reads return nothing
  std::set<uint32_t> unreadable;                   // segments whose reads always return nothing
  std::set<uint32_t> noStat;                       // segments whose size cannot be read
  std::set<uint32_t> undeletable;                  // segments whose delete fails
  int reads = 0, removeCalls = 0;

  std::vector<uint32_t> list() override {
    std::vector<uint32_t> v;
    for (auto it = files.rbegin(); it != files.rend(); ++it) v.push_back(it->first);  // not sorted on purpose
    return v;
  }
  long sizeOf(uint32_t n) override {
    auto it = files.find(n);
    return it == files.end() || noStat.count(n) ? -1 : (long)it->second.size();
  }
  bool openForAppend(uint32_t n) override {
    open = 0;
    pending.clear();
    if (failOpen) return false;
    files[n];
    open = n;
    return true;
  }
  bool write(const uint8_t* p, size_t n) override {
    if (!open) return false;
    pending.insert(pending.end(), p, p + n);
    return true;
  }
  void flush() override {
    if (!open) return;
    auto& f = files[open];
    bool room = usedBytes() + pending.size() <= total;
    if (!failFlush && room) f.insert(f.end(), pending.begin(), pending.end());
    pending.clear();
  }
  void close() override {
    flush();
    open = 0;
  }
  size_t read(uint32_t n, size_t off, uint8_t* buf, size_t len) override {
    reads++;
    auto it = files.find(n);
    if (it == files.end() || off >= it->second.size()) return 0;
    if (unreadable.count(n)) return 0;
    if (failReads > 0) {
      failReads--;
      return 0;
    }
    size_t got = std::min(len, it->second.size() - off);
    if (maxRead) got = std::min(got, maxRead);
    std::memcpy(buf, it->second.data() + off, got);
    return got;
  }
  bool remove(uint32_t n) override {
    removeCalls++;
    if (undeletable.count(n)) return false;
    files.erase(n);
    if (open == n) open = 0;
    return true;
  }
  // Two blocks for the filesystem itself, and every file takes whole 4 KiB blocks.
  size_t usedBytes() override {
    size_t used = 8192;
    for (auto& f : files) used += 4096 * std::max<size_t>(1, (f.second.size() + 4095) / 4096);
    return used;
  }
  size_t pendingRecords() const { return pending.size() / kRec; }
  void powerCut() {
    pending.clear();
    open = 0;
  }
};

static void makeRecord(uint32_t seq, uint8_t* r) {
  std::memcpy(r, &seq, 4);
  for (size_t i = 4; i < kRec; i++) r[i] = (uint8_t)(seq * 31 + i);
}

static void putRecords(std::vector<uint8_t>& file, uint32_t first, uint32_t count) {
  for (uint32_t s = first; s < first + count; s++) {
    uint8_t r[kRec];
    makeRecord(s, r);
    file.insert(file.end(), r, r + kRec);
  }
}

struct Harness {
  FakeFs fs;
  std::unique_ptr<segq::Queue> q;
  segq::Config cfg;
  uint32_t next = 1;               // sequence number of the next record
  std::vector<uint32_t> received;  // in order of arrival
  int posts = 0;
  int broken = 0;                  // uploads that were not whole, sound records
  bool retried = false;            // the last pass ended at a segment that failed its read

  void boot() {
    q.reset(new segq::Queue(fs));
    q->begin(cfg);
  }

  void add(uint32_t n, bool flushNow = false) {
    for (uint32_t i = 0; i < n; i++) {
      uint8_t r[kRec];
      makeRecord(next++, r);
      q->append(r, flushNow);
    }
  }

  // One upload pass. serverOk = false: the POST fails and nothing is acknowledged.
  // cap is the largest body, as uploadPass() takes it from the upload policy.
  int pass(bool serverOk, int maxPosts = 4, size_t cap = kUpload) {
    static uint8_t buf[kUpload];
    int sent = 0;
    bool rotated = false;
    retried = false;
    while (sent < maxPosts) {
      uint32_t lastSeg;
      bool retrying;
      size_t n = q->readBatch(buf, cap, lastSeg, retrying);
      retried = retrying;
      if (n == 0) {
        if (retrying || rotated || !q->rotate()) return sent;
        rotated = true;
        continue;
      }
      sent++;
      posts++;
      if (!serverOk) return sent;
      if (n % kRec || n > cap) broken++;
      for (size_t o = 0; o + kRec <= n; o += kRec) {
        uint32_t seq;
        std::memcpy(&seq, buf + o, 4);
        uint8_t want[kRec];
        makeRecord(seq, want);
        if (std::memcmp(want, buf + o, kRec) != 0) broken++;
        received.push_back(seq);
      }
      q->ack(lastSeg);
      if (retrying) return sent;
    }
    return sent;
  }

  // Passes until one sends nothing and did not stop at a failed read. The device keeps
  // making passes, so a segment that failed its read gets its next try.
  void drain() {
    for (int i = 0; i < 10000 && (pass(true) > 0 || retried); i++) {}
  }

  // True if exactly first..last arrived, once each and in order.
  bool gotRange(uint32_t first, uint32_t last, size_t from = 0) const {
    if (received.size() - from != (size_t)(last - first + 1)) return false;
    for (size_t i = from; i < received.size(); i++) {
      if (received[i] != first + (uint32_t)(i - from)) return false;
    }
    return true;
  }

  bool strictlyRising() const {
    for (size_t i = 1; i < received.size(); i++) {
      if (received[i] <= received[i - 1]) return false;
    }
    return true;
  }
};

// Uploads work: each pass closes the open segment and sends it, also when its last
// records were not flushed yet (the old code deleted such a segment).
static void online() {
  Harness h;
  h.boot();
  h.add(15);
  CHECK_EQ(h.pass(true), 1);
  CHECK(h.gotRange(1, 15));
  h.add(3);  // fewer than one flush
  CHECK_EQ(h.fs.pendingRecords(), 3);
  CHECK_EQ(h.pass(true), 1);
  CHECK(h.gotRange(1, 18));
  CHECK_EQ(h.pass(true), 0);  // nothing new: no rotation, no empty files
  CHECK_EQ(h.pass(true), 0);
  CHECK_EQ(h.fs.files.size(), 1);
  CHECK_EQ(h.q->dropped(), 0);
  CHECK_EQ(h.broken, 0);

  uint32_t segments;
  size_t bytes;
  h.add(7);
  h.q->count(segments, bytes);
  CHECK_EQ(segments, 1);
  CHECK_EQ(bytes, 7 * kRec);  // counts unflushed records too
}

// No network for 2000 records, then it comes back.
static void outageThenDrain() {
  Harness h;
  h.boot();
  h.add(2000);
  // Rotation happened in append(): five full segments and the open one.
  CHECK_EQ(h.fs.files.size(), 6);
  for (auto& f : h.fs.files) CHECK(f.second.size() <= kSegRecords * kRec);
  uint32_t segments;
  size_t bytes;
  h.q->count(segments, bytes);
  CHECK_EQ(segments, 6);
  CHECK_EQ(bytes, 2000 * kRec);

  CHECK_EQ(h.pass(true), 4);  // a pass stops after four uploads
  CHECK(h.gotRange(1, 4 * kSegRecords));
  h.add(20);                  // readings keep coming during the drain
  h.drain();
  CHECK(h.gotRange(1, 2020));
  CHECK_EQ(h.fs.files.size(), 1);
  CHECK_EQ(h.q->dropped(), 0);
  CHECK_EQ(h.broken, 0);
}

// The link is up but every upload fails, for 200 tries. The old code made one small
// file per try. Now the open segment is closed only when nothing else is waiting.
static void failingUploadsDoNotPileUp() {
  Harness h;
  h.boot();
  for (int i = 0; i < 200; i++) {
    h.add(15);
    CHECK_EQ(h.pass(false), 1);
  }
  CHECK(h.fs.files.size() <= 3000 / kSegRecords + 3);
  CHECK(h.received.empty());
  h.drain();
  CHECK(h.gotRange(1, 3000));
  CHECK_EQ(h.q->dropped(), 0);
  CHECK_EQ(h.broken, 0);
}

// Flash as older firmware can leave it: one file with a whole outage in it (1000
// records and a torn tail), a normal one, and an empty one.
static void legacyOversizedSegment(int rebootAfterPieces, bool failOnce) {
  Harness h;
  putRecords(h.fs.files[3], 1, 1000);
  for (int i = 0; i < 20; i++) h.fs.files[3].push_back(0xEE);  // torn tail
  putRecords(h.fs.files[4], 1001, 10);
  h.fs.files[5];
  h.next = 1011;
  h.boot();
  CHECK_EQ(h.q->curSeg(), 6);
  h.add(5);

  // First piece: one upload body, and the file stays whole.
  CHECK_EQ(h.pass(true, 1), 1);
  CHECK(h.gotRange(1, kSegRecords));
  CHECK_EQ(h.fs.sizeOf(3), (long)(1000 * kRec + 20));
  uint32_t segments;
  size_t bytes;
  h.q->count(segments, bytes);
  CHECK_EQ(bytes, (1000 - kSegRecords) * kRec + 20 + 10 * kRec + 5 * kRec);

  if (failOnce) {
    // A failed upload repeats the same piece, it does not skip or resend the first.
    CHECK_EQ(h.pass(false, 1), 1);
    CHECK(h.gotRange(1, kSegRecords));
  }

  size_t from = 0;
  if (rebootAfterPieces) {
    for (int i = 1; i < rebootAfterPieces; i++) CHECK_EQ(h.pass(true, 1), 1);
    CHECK(h.gotRange(1, (uint32_t)rebootAfterPieces * kSegRecords));
    CHECK(h.fs.sizeOf(3) > 0);
    // Power cut. The position was in RAM, so the file goes out again from its start.
    // The backend ignores the repeats. Nothing may be missing. (The 5 new records were
    // flushed, so they are still there too.)
    h.fs.powerCut();
    h.boot();
    from = h.received.size();
  }
  h.drain();
  CHECK(h.gotRange(1, 1015, from));
  CHECK_EQ(h.fs.sizeOf(3), -1);  // deleted, but only after its last piece
  CHECK_EQ(h.fs.sizeOf(4), -1);
  CHECK_EQ(h.fs.sizeOf(5), -1);
  CHECK_EQ(h.q->dropped(), 0);
  CHECK_EQ(h.broken, 0);         // the torn tail was never sent
}

// A long outage on a small partition: the oldest segments go, the newest stay, and the
// count of dropped records is exact.
static void spaceCap() {
  Harness h;
  h.fs.total = 256 * 1024;
  h.cfg.capBytes = h.fs.total / 100 * 80;
  h.boot();
  size_t worst = 0;
  for (int i = 0; i < 200; i++) {
    h.add(100);
    worst = std::max(worst, h.fs.usedBytes());
  }
  // Never more than the limit plus the segment being written.
  CHECK(worst <= h.cfg.capBytes + kSegRecords * kRec + 4096);
  CHECK(h.q->dropped() > 0);
  CHECK(h.q->capSegments() > 0);
  CHECK_EQ(h.q->lostWrites(), 0);
  h.drain();
  // What arrived is the newest stretch, whole and in order.
  CHECK(!h.received.empty());
  if (h.received.empty()) return;
  CHECK_EQ(h.received.back(), 20000);
  CHECK(h.gotRange(h.received.front(), 20000));
  CHECK_EQ(h.q->dropped(), h.received.front() - 1);
  CHECK_EQ(h.broken, 0);
}

// A limit so low that it is always exceeded. Closed segments go, but the segment being
// written must survive, or nothing could ever be stored again.
static void capNeverDeletesTheOpenSegment() {
  Harness h;
  h.cfg.capBytes = 4096;
  h.boot();
  h.add(10);
  CHECK(h.q->rotate());
  CHECK_EQ(h.q->dropped(), 10);  // the closed segment was over the limit at once
  CHECK_EQ(h.fs.sizeOf(h.q->curSeg()), 0);
  h.add(5);
  CHECK_EQ(h.fs.sizeOf(h.q->curSeg()), (long)(5 * kRec));
  CHECK_EQ(h.q->dropped(), 10);
  CHECK_EQ(h.q->lostWrites(), 0);
}

// Old firmware filled the flash far past the limit. The first boots clear it in steps.
static void capAtBoot() {
  Harness h;
  h.fs.total = 256 * 1024;
  h.cfg.capBytes = h.fs.total / 100 * 80;
  for (uint32_t n = 1; n <= 60; n++) putRecords(h.fs.files[n], (n - 1) * 15 + 1, 15);  // 60 files, one block each
  CHECK(h.fs.usedBytes() > h.cfg.capBytes);
  h.next = 901;
  h.boot();
  CHECK_EQ(h.q->capSegments(), 8);  // capPassMax per check
  CHECK_EQ(h.q->dropped(), 8 * 15);
  h.add(kSegRecords + 1);           // the next rotation checks again
  CHECK(h.fs.usedBytes() <= h.cfg.capBytes);
  uint32_t droppedNow = h.q->dropped();
  h.drain();
  CHECK(h.strictlyRising());
  CHECK_EQ(h.received.size() + droppedNow, 900 + kSegRecords + 1);
}

// Flushes fail for a while (a failing flash, or a full one without the limit).
static void failedWrites() {
  Harness h;
  h.boot();
  h.add(12);  // 1..10 flushed, 11 and 12 buffered
  h.fs.failFlush = true;
  h.add(10);  // 13..22: the flushes after 15 and 20 lose 11..15 and 16..20
  CHECK_EQ(h.q->dropped(), 10);
  CHECK_EQ(h.q->lostWrites(), 10);
  h.fs.failFlush = false;
  h.add(10);  // 23..32
  h.drain();
  std::vector<uint32_t> want;
  for (uint32_t s = 1; s <= 10; s++) want.push_back(s);
  for (uint32_t s = 21; s <= 32; s++) want.push_back(s);
  CHECK(h.received == want);
  CHECK_EQ(h.q->dropped(), 10);
  CHECK_EQ(h.broken, 0);

  // A failure that only shows when the segment is closed is counted as well.
  h.add(3);  // 33..35, buffered
  h.fs.failFlush = true;
  CHECK(h.q->rotate());
  h.fs.failFlush = false;
  CHECK_EQ(h.q->dropped(), 13);
  h.add(2);  // 36, 37
  h.drain();
  CHECK_EQ(h.received.size(), want.size() + 2);
  CHECK(h.received.back() == 37);
}

// The flash runs full with no limit set: new records are lost and counted, old ones
// stay intact, and once uploads make room everything works again.
static void fullFlash() {
  Harness h;
  h.fs.total = 64 * 1024;
  h.boot();
  h.add(3000);
  CHECK(h.q->dropped() > 0);
  uint32_t dropped = h.q->dropped();
  h.drain();
  CHECK(h.strictlyRising());
  CHECK_EQ(h.received.size() + dropped, 3000);
  CHECK_EQ(h.broken, 0);
  size_t before = h.received.size();
  h.add(50);
  h.drain();
  CHECK_EQ(h.received.size(), before + 50);
  CHECK_EQ(h.q->dropped(), dropped);
}

// Power cut: at most the unflushed records are gone, and the old segment is not reused.
static void powerCut() {
  Harness h;
  h.boot();
  h.add(7);  // 1..5 flushed, 6 and 7 buffered
  h.fs.powerCut();
  h.boot();
  CHECK_EQ(h.q->curSeg(), 2);
  h.add(3);  // 8..10
  CHECK_EQ(h.fs.sizeOf(1), (long)(5 * kRec));
  h.drain();
  std::vector<uint32_t> want = {1, 2, 3, 4, 5, 8, 9, 10};
  CHECK(h.received == want);

  // A quiet record is flushed at once, so it survives a power cut right after it.
  h.add(1, true);  // 11
  CHECK_EQ(h.fs.pendingRecords(), 0);
  h.fs.powerCut();
  h.boot();
  h.drain();
  CHECK(!h.received.empty() && h.received.back() == 11);
}

// Boots that never write leave empty files. They are cleaned up, never uploaded.
static void emptyLeftovers() {
  Harness h;
  h.boot();
  h.fs.powerCut();
  h.boot();
  h.fs.powerCut();
  h.boot();
  CHECK_EQ(h.fs.files.size(), 3);
  CHECK_EQ(h.pass(true), 0);
  CHECK_EQ(h.posts, 0);
  CHECK_EQ(h.fs.files.size(), 1);
  CHECK_EQ(h.fs.sizeOf(h.q->curSeg()), 0);
}

// A read that returns less than asked must not cost the rest of the segment.
static void shortReads() {
  Harness h;
  h.boot();
  h.add(25);
  h.pass(false);  // closes the segment
  h.add(25);
  h.pass(false);
  h.fs.maxRead = 10 * kRec + 7;
  h.add(4);
  h.drain();
  CHECK(h.gotRange(1, 54));
  CHECK_EQ(h.broken, 0);
  CHECK_EQ(h.fs.files.size(), 1);
}

// The segment file cannot be created for a while.
static void openFailures() {
  Harness h;
  h.fs.failOpen = true;
  h.boot();
  h.add(5);
  CHECK_EQ(h.q->dropped(), 5);
  CHECK_EQ(h.q->openFailures(), 5);
  h.fs.failOpen = false;
  h.add(5);
  h.drain();
  CHECK(h.gotRange(6, 10));
}

// One read of a closed segment returns nothing, once (low heap is enough). The old code
// skipped the segment, and the next acknowledged upload deleted it without a count.
static void failedReadIsTriedAgain() {
  Harness h;
  h.boot();
  h.add(2 * kSegRecords + 10);  // two closed segments and the open one
  h.fs.failReads = 1;
  h.drain();
  CHECK(h.gotRange(1, 2 * kSegRecords + 10));
  CHECK_EQ(h.q->dropped(), 0);
  CHECK_EQ(h.fs.files.size(), 1);

  // Three failures in a row while driving, so records keep coming between passes. The
  // batch ends before the segment each time, so nothing newer is acknowledged over it,
  // and the fourth read brings it in. Each pass tries it once and leaves the open
  // segment alone. The old code tried twice per pass and closed the open segment for it.
  Harness k;
  k.boot();
  k.add(2 * kSegRecords + 10);
  k.fs.failReads = 3;
  uint32_t open = k.q->curSeg();
  for (int i = 0; i < 3; i++) {
    int readsBefore = k.fs.reads;
    CHECK_EQ(k.pass(true), 0);
    CHECK_EQ(k.fs.reads - readsBefore, 1);
    k.add(15);
  }
  CHECK_EQ(k.q->curSeg(), open);
  CHECK(k.received.empty());
  k.drain();
  CHECK(k.gotRange(1, 2 * kSegRecords + 10 + 45));
  CHECK_EQ(k.q->dropped(), 0);
  CHECK_EQ(k.q->lostSegments(), 0);
  CHECK_EQ(k.broken, 0);

  // The oldest segment cannot be read for two passes (about 15 s of low heap while
  // driving), then it can. The old code spent all four tries in those two passes, gave
  // it up and deleted it with the upload behind it: 341 readable records lost.
  Harness t;
  t.boot();
  t.add(2 * kSegRecords + 10);
  t.fs.unreadable.insert(1);
  for (int i = 0; i < 2; i++) {
    CHECK_EQ(t.pass(true), 0);
    t.add(15);
  }
  t.fs.unreadable.clear();
  t.drain();
  CHECK(t.gotRange(1, 2 * kSegRecords + 10 + 30));
  CHECK_EQ(t.q->dropped(), 0);
  CHECK_EQ(t.q->lostSegments(), 0);

  // Small segments go out together. The batch ends before one that fails its read, is
  // sent, and the pass ends there: that segment gets one try in this pass, not two.
  Harness b;
  putRecords(b.fs.files[1], 1, 15);
  putRecords(b.fs.files[2], 16, 15);
  putRecords(b.fs.files[3], 31, 15);
  b.next = 46;
  b.boot();
  b.fs.unreadable.insert(2);
  int readsBefore = b.fs.reads;
  CHECK_EQ(b.pass(true), 1);
  CHECK(b.gotRange(1, 15));
  CHECK_EQ(b.fs.reads - readsBefore, 2);  // segment 1, and one try of segment 2
  CHECK_EQ(b.pass(true), 0);              // the second try
  CHECK_EQ(b.pass(true), 0);              // the third
  b.fs.unreadable.clear();
  b.add(5);
  b.drain();
  CHECK(b.gotRange(1, 50));
  CHECK_EQ(b.q->dropped(), 0);
  CHECK_EQ(b.q->lostSegments(), 0);

  // A segment that goes out in pieces fails one read in the middle, with a newer
  // segment waiting behind it. It continues where it was.
  Harness p;
  putRecords(p.fs.files[3], 1, 1000);
  putRecords(p.fs.files[4], 1001, 10);
  p.next = 1011;
  p.boot();
  CHECK_EQ(p.pass(true, 1), 1);
  p.fs.failReads = 1;
  CHECK_EQ(p.pass(true, 1), 0);
  p.drain();
  CHECK(p.gotRange(1, 1010));
  CHECK_EQ(p.q->dropped(), 0);
}

// A segment that never reads is given up after its tries. It is counted as dropped,
// once, and what is behind it still goes out.
static void unreadableSegmentIsCountedOnce() {
  Harness h;
  h.boot();
  h.add(2 * kSegRecords + 10);
  h.fs.unreadable.insert(1);
  CHECK_EQ(h.pass(true), 0);  // one try per pass
  CHECK_EQ(h.pass(true), 0);
  CHECK_EQ(h.pass(true), 0);
  CHECK_EQ(h.q->dropped(), 0);  // not given up yet
  // Fourth try: given up. The upload behind it fails, so the queue runs over it again.
  CHECK_EQ(h.pass(false), 1);
  CHECK_EQ(h.q->dropped(), kSegRecords);
  CHECK_EQ(h.pass(false), 1);
  CHECK_EQ(h.pass(false), 1);
  CHECK_EQ(h.q->dropped(), kSegRecords);
  CHECK(h.fs.sizeOf(1) > 0);  // the file goes when a later segment is acknowledged
  h.drain();
  CHECK(h.gotRange(kSegRecords + 1, 2 * kSegRecords + 10));
  CHECK_EQ(h.q->dropped(), kSegRecords);
  CHECK_EQ(h.q->unreadable(), kSegRecords);
  CHECK_EQ(h.q->lostSegments(), 1);
  CHECK_EQ(h.fs.sizeOf(1), -1);
  CHECK_EQ(h.fs.files.size(), 1);
  CHECK_EQ(h.broken, 0);

  // Two such segments in a row must not block each other.
  Harness two;
  two.boot();
  two.add(3 * kSegRecords + 10);
  two.fs.unreadable.insert(1);
  two.fs.unreadable.insert(2);
  int passes = 0;
  while (two.received.empty() && passes < 20) {
    two.pass(true);
    passes++;
  }
  CHECK(passes <= 2 * (segq::kReadTries + 1));  // one try per pass, four tries each
  two.drain();
  CHECK(two.gotRange(2 * kSegRecords + 1, 3 * kSegRecords + 10));
  CHECK_EQ(two.q->dropped(), 2 * kSegRecords);
  CHECK_EQ(two.fs.files.size(), 1);

  // A segment whose size cannot be read is given up the same way. How many records it
  // held is unknown, so none are counted.
  Harness st;
  st.boot();
  st.add(2 * kSegRecords + 10);
  st.fs.noStat.insert(1);
  CHECK_EQ(st.pass(true), 0);
  CHECK_EQ(st.pass(true), 0);
  st.drain();
  CHECK(st.gotRange(kSegRecords + 1, 2 * kSegRecords + 10));
  CHECK_EQ(st.q->lostSegments(), 1);
  CHECK_EQ(st.q->dropped(), 0);
}

// A segment that was given up and is then deleted for space is not counted twice.
static void unreadableSegmentAndTheSpaceCap() {
  Harness h;
  h.cfg.capBytes = 49152;  // room for two full segments, a small one and an empty one
  h.boot();
  h.add(2 * kSegRecords + 10);
  h.fs.unreadable.insert(1);
  for (int i = 0; i <= segq::kReadTries; i++) h.pass(false);  // one try per pass
  CHECK_EQ(h.q->dropped(), kSegRecords);
  CHECK_EQ(h.q->capSegments(), 0);
  h.add(kSegRecords + 1);  // the next rotation is over the limit and deletes segment 1
  CHECK_EQ(h.q->capSegments(), 1);
  CHECK_EQ(h.fs.sizeOf(1), -1);
  CHECK_EQ(h.q->dropped(), kSegRecords);
  h.drain();
  CHECK(h.gotRange(kSegRecords + 1, 3 * kSegRecords + 11));
  CHECK_EQ(h.received.size() + h.q->dropped(), h.next - 1);
}

// The oldest segment cannot be deleted while a dead zone keeps the flash over the limit.
// The old code counted it as dropped on every space check, though it was still there
// and went out later: 1,705 records too many in the review's run.
static void undeletableSegmentAndTheSpaceCap() {
  Harness h;
  h.fs.total = 160 * 1024;
  h.cfg.capBytes = h.fs.total / 100 * 80;
  h.boot();
  h.fs.undeletable.insert(1);
  h.add(4433);  // 13 segments, no network
  CHECK(h.q->capSegments() > 0);
  CHECK(h.fs.sizeOf(1) > 0);
  CHECK_EQ(h.q->dropped(), h.q->capSegments() * kSegRecords);  // only what is really gone
  CHECK_EQ(h.q->lostWrites(), 0);
  h.fs.undeletable.clear();
  h.drain();
  CHECK(h.strictlyRising());
  CHECK(!h.received.empty() && h.received.front() == 1);  // segment 1 was kept and sent
  CHECK_EQ(h.received.size() + h.q->dropped(), h.next - 1);
  CHECK_EQ(h.fs.files.size(), 1);
  CHECK_EQ(h.broken, 0);

  // The same for a segment given up as unreadable. It is counted once, when it is given
  // up. The old code took it off the list of given-up segments, so it was read again
  // with four fresh tries and counted a second time.
  Harness u;
  u.fs.total = 160 * 1024;
  u.cfg.capBytes = u.fs.total / 100 * 80;
  u.boot();
  u.add(2 * kSegRecords + 10);
  u.fs.unreadable.insert(1);
  u.fs.undeletable.insert(1);
  for (int i = 0; i <= segq::kReadTries; i++) u.pass(false);
  CHECK_EQ(u.q->lostSegments(), 1);
  CHECK_EQ(u.q->dropped(), kSegRecords);
  u.add(4000);
  CHECK(u.q->capSegments() > 0);
  CHECK_EQ(u.q->dropped(), kSegRecords + u.q->capSegments() * kSegRecords);
  for (int i = 0; i < 10; i++) u.pass(false);
  CHECK_EQ(u.q->lostSegments(), 1);
  u.fs.undeletable.clear();
  u.drain();
  CHECK_EQ(u.q->lostSegments(), 1);
  CHECK_EQ(u.q->unreadable(), kSegRecords);
  CHECK(u.strictlyRising());
  CHECK_EQ(u.received.size() + u.q->dropped(), u.next - 1);
  CHECK_EQ(u.fs.sizeOf(1), -1);
  CHECK_EQ(u.fs.files.size(), 1);
}

// The delete after an accepted upload fails. The old code read the same segment again
// on every pass and posted it forever, with nothing newer behind it.
static void undeletableSegmentIsNotSentAgain() {
  Harness h;
  h.boot();
  h.add(2 * kSegRecords + 10);
  h.fs.undeletable.insert(1);
  h.drain();
  CHECK(h.gotRange(1, 2 * kSegRecords + 10));
  CHECK_EQ(h.posts, 3);
  CHECK_EQ(h.q->stuckSegments(), 1);
  CHECK(h.fs.sizeOf(1) > 0);
  for (int i = 0; i < 50; i++) {
    h.add(15);
    CHECK_EQ(h.pass(true), 1);
  }
  CHECK(h.gotRange(1, 2 * kSegRecords + 10 + 50 * 15));
  CHECK_EQ(h.posts, 53);
  CHECK_EQ(h.q->stuckSegments(), 1);
  CHECK_EQ(h.q->dropped(), 0);
  // The delete is tried again on every pass and goes through once it can.
  h.fs.undeletable.clear();
  CHECK_EQ(h.pass(true), 0);
  CHECK_EQ(h.fs.sizeOf(1), -1);
  CHECK_EQ(h.fs.files.size(), 1);

  // The same for a segment that went out in pieces: after its last piece the delete
  // fails. It must not start again from its first record.
  Harness p;
  putRecords(p.fs.files[3], 1, 1000);
  p.next = 1001;
  p.boot();
  p.fs.undeletable.insert(3);
  p.add(5);
  p.drain();
  CHECK(p.gotRange(1, 1005));
  for (int i = 0; i < 10; i++) {
    p.add(15);
    p.pass(true);
  }
  CHECK(p.gotRange(1, 1005 + 150));
  CHECK_EQ(p.q->stuckSegments(), 1);
  CHECK_EQ(p.broken, 0);
}

// The upload loop's fallback: after refused full-size uploads it asks for 30 records at
// a time. Full segments then go out in pieces, complete, in order and once each.
static void smallUploadBodies() {
  const size_t small = 30 * kRec;
  Harness h;
  h.boot();
  h.add(1000);  // two full segments and the open one
  CHECK_EQ(h.pass(false, 1), 1);  // a refused full-size upload first
  for (int i = 0; i < 100 && h.pass(true, 4, small) > 0; i++) {}
  CHECK(h.gotRange(1, 1000));
  CHECK_EQ(h.posts, 1 + 12 + 12 + 11);  // 341 = 11 x 30 + 11, twice, and 318 = 10 x 30 + 18
  CHECK_EQ(h.broken, 0);                // no body over the limit
  CHECK_EQ(h.fs.files.size(), 1);
  CHECK_EQ(h.q->dropped(), 0);

  // The limit changes between passes, also in the middle of a segment.
  Harness m;
  m.boot();
  m.add(1500);
  for (int i = 0; i < 100; i++) {
    if (m.pass(true, 1, i % 2 ? kUpload : small) == 0) break;
  }
  CHECK(m.gotRange(1, 1500));
  CHECK_EQ(m.broken, 0);
  CHECK_EQ(m.fs.files.size(), 1);
}

// Random mix of appends, passes with full and small bodies, failed uploads, failed
// reads and failed deletes. Every record arrives exactly once and in order, or is in
// the count of dropped records.
static void randomFaults() {
  uint32_t rng = 24680;
  auto rnd = [&rng](uint32_t n) {
    rng = rng * 1664525u + 1013904223u;
    return (rng >> 8) % n;
  };
  for (int run = 0; run < 20; run++) {
    Harness h;
    h.boot();
    for (int step = 0; step < 400; step++) {
      uint32_t what = rnd(100);
      if (what < 55) {
        h.add(1 + rnd(what < 5 ? 800 : 40), rnd(10) == 0);
      } else if (what < 75) {
        h.pass(true, 4, rnd(3) == 0 ? 30 * kRec : kUpload);
      } else if (what < 85) {
        h.pass(false);
      } else if (what < 92) {
        h.fs.failReads = 1 + (int)rnd(5);
      } else if (what < 97) {
        uint32_t cur = h.q->curSeg();
        if (cur > 1) h.fs.undeletable.insert(cur - 1);
      } else {
        h.fs.undeletable.clear();
      }
    }
    h.fs.failReads = 0;
    h.fs.undeletable.clear();
    h.add(1);  // so that one more upload is acknowledged and clears what was given up
    h.drain();
    h.pass(true);
    CHECK(h.strictlyRising());
    CHECK_EQ(h.broken, 0);
    CHECK_EQ(h.received.size() + h.q->dropped(), h.next - 1);
    CHECK_EQ(h.q->dropped(), h.q->unreadable());
    CHECK_EQ(h.fs.files.size(), 1);
  }
}

// Random mix of appends, good and failed passes and power cuts. Every record either
// arrives exactly once, in order, or was still in the write buffer when the power went.
static void randomRuns() {
  uint32_t rng = 12345;
  auto rnd = [&rng](uint32_t n) {
    rng = rng * 1664525u + 1013904223u;
    return (rng >> 8) % n;
  };
  for (int run = 0; run < 20; run++) {
    Harness h;
    h.boot();
    std::set<uint32_t> cut;  // records lost to power cuts
    for (int step = 0; step < 400; step++) {
      uint32_t what = rnd(100);
      if (what < 60) {
        h.add(1 + rnd(what < 5 ? 800 : 40), rnd(10) == 0);
      } else if (what < 80) {
        h.pass(true);
      } else if (what < 95) {
        h.pass(false);
      } else {
        for (size_t i = 0; i < h.fs.pendingRecords(); i++) cut.insert(h.next - 1 - (uint32_t)i);
        h.fs.powerCut();
        h.boot();
      }
    }
    h.drain();
    CHECK(h.strictlyRising());
    CHECK_EQ(h.broken, 0);
    CHECK_EQ(h.received.size() + cut.size(), h.next - 1);
    bool overlap = false;
    for (uint32_t s : h.received) overlap = overlap || cut.count(s);
    CHECK(!overlap);
    CHECK_EQ(h.fs.files.size(), 1);
    for (auto& f : h.fs.files) CHECK(f.second.size() <= kSegRecords * kRec);
  }
}

int main() {
  online();
  outageThenDrain();
  failingUploadsDoNotPileUp();
  legacyOversizedSegment(0, false);
  legacyOversizedSegment(0, true);
  legacyOversizedSegment(1, false);
  legacyOversizedSegment(2, true);
  spaceCap();
  capNeverDeletesTheOpenSegment();
  capAtBoot();
  failedWrites();
  fullFlash();
  powerCut();
  emptyLeftovers();
  shortReads();
  openFailures();
  failedReadIsTriedAgain();
  unreadableSegmentIsCountedOnce();
  unreadableSegmentAndTheSpaceCap();
  undeletableSegmentAndTheSpaceCap();
  undeletableSegmentIsNotSentAgain();
  smallUploadBodies();
  randomFaults();
  randomRuns();
  return finish("test_seg_queue");
}
