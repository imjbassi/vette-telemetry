#pragma once
#include <Arduino.h>
#include "record.h"

// Append-only segment queue on LittleFS: /q/00000042.bin, each holding whole Records.
// The writer appends to the open segment. The uploader asks for a rotation, then reads
// closed segments oldest first and deletes them after a 2xx. A power cut can at worst
// leave a truncated last record in the open segment, which the backend discards.
namespace storage {

bool begin();
void append(const Record& r);           // thread-safe
void rotate();                          // close current segment, open a new one

// Fill buf with whole closed segments, oldest first, up to cap bytes.
// Returns bytes used and the highest segment number included (for ack()).
size_t readBatch(uint8_t* buf, size_t cap, uint32_t& lastSeg);
void ack(uint32_t lastSeg);             // delete all closed segments <= lastSeg
size_t pendingBytes();

}  // namespace storage
