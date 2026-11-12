#pragma once
#include <Arduino.h>
#include "record.h"

// Append-only segment queue on LittleFS: /q/00000042.bin, each holding whole Records.
// (The bench build uses /qbench, so its scripted records never meet a normal build.)
// The writer appends to the open segment and closes it at 341 records (one upload body),
// with or without a network. The uploader reads closed segments oldest first and deletes
// them after a 2xx. Nothing is ever cut short: a segment leaves the queue only after it
// was uploaded in full, or as the oldest one when the flash passes QUEUE_MAX_PCT.
// A power cut loses at most the last FLUSH_EVERY records of the open segment.
namespace storage {

struct Stats {
  uint32_t segments;  // segment files, the open one included
  size_t bytes;       // record bytes waiting for upload, flushed or not
  uint32_t dropped;   // records lost since boot: failed writes, unreadable segments, segments deleted for space
  size_t fsUsed;      // LittleFS bytes in use
  size_t fsTotal;     // LittleFS partition size
};

bool begin();
// Thread-safe. flushNow pushes this record (and any before it) to flash at once.
void append(const Record& r, bool flushNow = false);
// Close the open segment and start a new one. Does nothing and returns false when the
// open segment has no records. Call it only when readBatch() returned 0 without
// retrying, so that small segments do not pile up while uploads are failing.
bool rotate();

// Fill buf with whole closed segments, oldest first, up to cap bytes. A segment larger
// than cap (left by older firmware, or cap is the small fallback size) comes out alone,
// one piece per call. Returns bytes used and the highest segment number included (for ack()).
// retrying = the batch ended before a segment that could not be read just now. End the
// upload pass then, so each pass tries it once. Its 4th failed read gives it up, and its
// records are counted as dropped.
size_t readBatch(uint8_t* buf, size_t cap, uint32_t& lastSeg, bool& retrying);
// The batch from the last readBatch() was uploaded. Deletes all closed segments
// <= lastSeg, or moves on to the next piece of an oversized one.
void ack(uint32_t lastSeg);
Stats stats();

}  // namespace storage
