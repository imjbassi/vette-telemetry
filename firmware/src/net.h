#pragma once
#include <Arduino.h>

// Network + position/time provider. Owned by the net task. Getters are thread-safe.
namespace net {

struct Fix {
  bool valid = false;
  int32_t lat_e7 = 0, lon_e7 = 0;
  uint8_t sats = 0;
};

bool begin();              // blocking bring-up, called from the net task
bool ready();              // data link up
void service();            // periodic housekeeping (GNSS, CSQ, reconnect). Net task only.
int  post(const uint8_t* body, size_t len);  // HTTP status, or negative on transport error
int  checkBackend();       // GET /health, HTTP status or negative. Run once when the link comes up.

Fix  fix();
uint8_t csq();             // 0..31, 99 unknown
// Unix seconds at millis()==0 for this boot, 0 if not known yet.
uint32_t epochBase();

}  // namespace net
