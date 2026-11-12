#pragma once
#include <stddef.h>
#include <stdint.h>
#include <algorithm>
#include <vector>

// The flash queue's logic without the filesystem. src/storage.cpp wraps it with LittleFS
// and a mutex. Plain C++17 with no Arduino headers, so test/host/test_seg_queue.cpp runs
// it on a PC against a fake filesystem: outages, failed uploads, power cuts, failed
// writes, a full flash, and oversized files left by older firmware.
//
// A segment is a numbered file of whole records. One segment is open for appending. The
// others are closed and wait for upload, oldest first. Rules:
//  - The open segment is closed when it holds one upload body (segRecords), with or
//    without a network. The count lives in RAM, because the size on flash only shows
//    flushed bytes.
//  - A segment leaves the queue only after all of it was uploaded, or as the oldest one
//    when the flash is over its limit. Nothing is cut short.
//  - A segment that is larger than one upload (older firmware wrote a whole outage into
//    one file, or the upload loop asks for small bodies) goes out in pieces. The position
//    is kept in RAM only: after a reboot the file is sent again from its start, and the
//    backend ignores records it already has.
//  - A segment that cannot be read is tried again on later passes before it is given up
//    and counted as dropped. A segment that was uploaded but cannot be deleted is never
//    sent a second time in this boot.

namespace segq {

constexpr uint8_t kReadTries = 3;  // failed reads of one segment that end the batch before it is given up

// What the queue needs from a filesystem.
struct Fs {
  virtual ~Fs() {}
  virtual std::vector<uint32_t> list() = 0;      // numbers of all segment files, any order, without opening them
  virtual long sizeOf(uint32_t seg) = 0;         // bytes committed to flash, -1 if there is no such file
  virtual bool openForAppend(uint32_t seg) = 0;  // create the file and make it the open segment
  virtual bool write(const uint8_t* p, size_t n) = 0;  // append to the open segment. May only buffer.
  virtual void flush() = 0;                      // push the open segment to flash. Reports nothing.
  virtual void close() = 0;                      // close the open segment
  virtual size_t read(uint32_t seg, size_t off, uint8_t* buf, size_t n) = 0;  // from a closed segment
  virtual bool remove(uint32_t seg) = 0;         // false = the file is still there
  virtual size_t usedBytes() = 0;                // filesystem bytes in use
};

struct Config {
  size_t recBytes = 48;       // size of one record
  uint32_t segRecords = 341;  // records per segment, one upload body
  uint32_t flushEvery = 5;    // records between flushes
  size_t capBytes = 0;        // delete the oldest closed segments above this much used space. 0 = no limit
  int capPassMax = 8;         // segments deleted per space check, keeps one call short
};

class Queue {
 public:
  explicit Queue(Fs& fs) : m_fs(fs) {}

  // Call once after mounting. Starts a new segment: one from a previous boot is never
  // appended to, its tail may be torn.
  void begin(const Config& cfg) {
    m_cfg = cfg;
    auto segs = sorted();
    m_curSeg = segs.empty() ? 0 : segs.back();
    openNext();
    enforceCap();
  }

  // flushNow pushes this record, and any before it, to flash at once.
  void append(const uint8_t* rec, bool flushNow) {
    if (m_open && m_curCount >= m_cfg.segRecords) rotateNow();
    if (!m_open) openNext();
    if (!m_open) {
      m_dropped++;
      m_openFailures++;
      return;
    }
    bool wrote = m_fs.write(rec, m_cfg.recBytes);
    m_curCount++;
    m_unflushed++;
    if (!wrote || flushNow || m_unflushed >= m_cfg.flushEvery) {
      // After a failed write the file is in an unknown state. Carry on in a fresh segment.
      if (!sync()) rotateNow();
    }
  }

  // Close the open segment and start a new one. Does nothing and returns false when the
  // open segment has no records.
  bool rotate() {
    if (m_curCount == 0) return false;
    rotateNow();
    return true;
  }

  // Fill buf with whole closed segments, oldest first, up to cap bytes. A segment larger
  // than cap comes out alone, one piece per call. Returns bytes used and the highest
  // segment number included (for ack()). retrying = the batch ended before a segment
  // that could not be read just now. The caller then ends its upload pass, so each pass
  // costs that segment one try and a short read failure cannot use up all its tries.
  size_t readBatch(uint8_t* buf, size_t cap, uint32_t& lastSeg, bool& retrying) {
    size_t used = 0;
    lastSeg = 0;
    retrying = false;
    m_partEnd = 0;
    for (uint32_t n : sorted()) {
      if (n >= m_curSeg) break;
      if (n <= m_ackedThrough) {
        // Uploaded already, but its delete failed. Try the delete again. Never read it:
        // it would go out again on every pass, with nothing newer behind it.
        m_fs.remove(n);
        continue;
      }
      if (isLost(n)) continue;  // given up and counted. It goes when a later segment is acknowledged.
      long raw = m_fs.sizeOf(n);
      if (raw < 0) {
        retrying = retryLater(n, 0);  // the size is unknown, so nothing can be counted
        if (retrying) break;
        continue;
      }
      size_t sz = (size_t)raw;
      sz -= sz % m_cfg.recBytes;  // a torn tail would shift every record behind it in the batch
      size_t off = n == m_partSeg ? m_partOff : 0;
      if (off >= sz) {
        // Empty, or every piece of it has been sent.
        m_fs.remove(n);
        if (n == m_partSeg) clearPart();
        continue;
      }
      size_t want = sz - off;
      bool piece = false;
      if (used + want > cap) {
        if (used) break;
        piece = true;  // larger than one upload: send it alone, piece by piece
        want = cap - cap % m_cfg.recBytes;
      }
      size_t got = m_fs.read(n, off, buf + used, want);
      got -= got % m_cfg.recBytes;
      if (got == 0) {
        retrying = retryLater(n, (sz - off) / m_cfg.recBytes);
        if (retrying) break;
        continue;
      }
      if (n == m_badSeg) m_badSeg = 0;  // it reads again
      used += got;
      lastSeg = n;
      if (piece || got < want) {
        // More of this segment is left. The file stays and the next call continues here.
        m_partSeg = n;
        m_partOff = off;
        m_partEnd = off + got;
        break;
      }
    }
    return used;
  }

  // The batch from the last readBatch() was uploaded. Deletes the closed segments it
  // held, or moves on to the next piece of a segment that is not finished.
  void ack(uint32_t lastSeg) {
    bool piece = m_partEnd && lastSeg == m_partSeg;
    for (uint32_t n : sorted()) {
      if (n > lastSeg || n >= m_curSeg) break;
      if (piece && n == lastSeg) break;
      if (!m_fs.remove(n)) stuck(n);
    }
    // Segments that were given up as unreadable went with this batch.
    m_lost.erase(std::remove_if(m_lost.begin(), m_lost.end(), [lastSeg](uint32_t n) { return n <= lastSeg; }),
                 m_lost.end());
    if (piece) {
      m_partOff = m_partEnd;
      m_partEnd = 0;
    } else if (m_partSeg && m_partSeg <= lastSeg) {
      clearPart();
    }
  }

  // Segment files (the open one included) and record bytes still to upload.
  void count(uint32_t& segments, size_t& bytes) {
    segments = 0;
    bytes = 0;
    for (uint32_t n : m_fs.list()) {
      segments++;
      if (m_open && n == m_curSeg) {
        bytes += (size_t)m_curCount * m_cfg.recBytes;
        continue;
      }
      long sz = m_fs.sizeOf(n);
      if (sz > 0) bytes += (size_t)sz;
    }
    if (m_partSeg) bytes -= std::min(bytes, m_partOff);
  }

  uint32_t curSeg() const { return m_curSeg; }
  uint32_t dropped() const { return m_dropped; }            // records lost, all causes
  uint32_t lostWrites() const { return m_lostWrites; }      // records lost to failed writes
  uint32_t capSegments() const { return m_capSegments; }    // segments deleted for space
  uint32_t openFailures() const { return m_openFailures; }  // appends that found no open segment
  uint32_t unreadable() const { return m_unreadable; }      // records lost in segments that could not be read
  uint32_t lostSegments() const { return m_lostSegs; }      // segments given up as unreadable
  uint32_t stuckSegments() const { return m_stuck; }        // uploaded segments whose delete failed

 private:
  std::vector<uint32_t> sorted() {
    std::vector<uint32_t> v = m_fs.list();
    std::sort(v.begin(), v.end());
    return v;
  }

  void clearPart() { m_partSeg = 0; m_partOff = m_partEnd = 0; }

  bool isLost(uint32_t n) const { return std::find(m_lost.begin(), m_lost.end(), n) != m_lost.end(); }

  // Closed segment n could not be read just now. True = end the batch before it, so a
  // later pass tries again: one failed read must not cost a whole segment. After
  // kReadTries failures in a row it is given up. It is then skipped, its records are
  // counted as dropped, once, and it is deleted when a later segment is acknowledged.
  bool retryLater(uint32_t n, size_t records) {
    if (n != m_badSeg) {
      m_badSeg = n;
      m_badTries = 0;
    }
    if (++m_badTries <= kReadTries) return true;
    m_badSeg = 0;
    m_lost.push_back(n);
    m_lostSegs++;
    m_dropped += (uint32_t)records;
    m_unreadable += (uint32_t)records;
    return false;
  }

  // Segment n was uploaded but its delete failed. Every closed segment up to n has been
  // acknowledged by then, so readBatch() skips them all from now on.
  void stuck(uint32_t n) {
    if (n <= m_ackedThrough) return;
    m_ackedThrough = n;
    m_stuck++;
  }

  void openNext() {
    m_curSeg++;
    m_open = m_fs.openForAppend(m_curSeg);
    m_curCount = 0;
    m_unflushed = 0;
  }

  // Pushes the open segment to flash and checks that it arrived. flush() reports nothing
  // and a failed write is only visible as a file that is shorter than it should be.
  // Returns false when records were lost. They are counted.
  bool sync() {
    if (!m_open || !m_unflushed) return true;
    m_fs.flush();
    m_unflushed = 0;
    long sz = m_fs.sizeOf(m_curSeg);
    uint32_t onFlash = sz > 0 ? (uint32_t)((size_t)sz / m_cfg.recBytes) : 0;
    if (onFlash >= m_curCount) return true;
    m_dropped += m_curCount - onFlash;
    m_lostWrites += m_curCount - onFlash;
    m_curCount = onFlash;
    return false;
  }

  void rotateNow() {
    if (m_open) {
      sync();
      m_fs.close();
    }
    openNext();
    enforceCap();
  }

  // Space limit. Above it the oldest closed segments are deleted, so new readings always
  // have room and the filesystem never runs full.
  void enforceCap() {
    if (!m_cfg.capBytes || m_fs.usedBytes() <= m_cfg.capBytes) return;
    int removed = 0;
    for (uint32_t n : sorted()) {
      if (n >= m_curSeg || removed >= m_cfg.capPassMax) break;
      long sz = m_fs.sizeOf(n);
      if (!m_fs.remove(n)) {
        // Still there, so nothing is lost yet. Counting it would repeat on every space
        // check. Forgetting how far it was sent, or that it was given up, would send it
        // from its start again or count it a second time.
        removed++;
        continue;
      }
      size_t gone = sz > 0 ? (size_t)sz : 0;
      if (n == m_partSeg) {
        gone -= std::min(gone, m_partOff);  // that much of it was uploaded
        clearPart();
      }
      auto lost = std::find(m_lost.begin(), m_lost.end(), n);
      if (lost != m_lost.end()) {
        m_lost.erase(lost);
        gone = 0;  // counted when it was given up
      }
      if (n <= m_ackedThrough) gone = 0;  // uploaded, only its delete failed
      removed++;
      m_capSegments++;
      m_dropped += (uint32_t)(gone / m_cfg.recBytes);
      if (m_fs.usedBytes() <= m_cfg.capBytes) break;
    }
  }

  Fs& m_fs;
  Config m_cfg;
  bool m_open = false;       // a segment is open for appending
  uint32_t m_curSeg = 0;
  uint32_t m_curCount = 0;   // records written to the open segment
  uint32_t m_unflushed = 0;  // of those, written since the last flush
  uint32_t m_dropped = 0;
  uint32_t m_lostWrites = 0;
  uint32_t m_capSegments = 0;
  uint32_t m_openFailures = 0;
  uint32_t m_unreadable = 0;
  uint32_t m_lostSegs = 0;
  uint32_t m_stuck = 0;
  uint32_t m_partSeg = 0;    // segment being sent in pieces, 0 = none
  size_t m_partOff = 0;      // bytes of it already acknowledged
  size_t m_partEnd = 0;      // end of the piece handed out by the last readBatch(), 0 = none
  uint32_t m_badSeg = 0;     // segment whose last read failed, 0 = none
  uint8_t m_badTries = 0;    // failed reads of it in a row
  std::vector<uint32_t> m_lost;  // segments given up as unreadable and not deleted yet
  uint32_t m_ackedThrough = 0;   // every closed segment up to this number was uploaded. Files at or below it only wait for their delete.
};

}  // namespace segq
