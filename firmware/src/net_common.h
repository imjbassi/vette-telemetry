#pragma once
#include "net.h"

// Shared state written by the active net backend.
namespace net::state {

inline portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
inline Fix fix;
inline uint8_t csq = 99;
inline uint32_t epochBase = 0;

inline void setEpochNow(uint32_t unixNow) {
  uint32_t base = unixNow - millis() / 1000;
  portENTER_CRITICAL(&mux);
  uint32_t old = epochBase;
  epochBase = base;
  portEXIT_CRITICAL(&mux);
  if (old == 0) Serial.printf("[time] epoch base %lu\n", (unsigned long)base);
  else if ((int32_t)(base - old) > 60 || (int32_t)(old - base) > 60)
    Serial.printf("[time] clock corrected by %ld s\n", (long)((int32_t)(base - old)));
}

// days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's algorithm)
inline int64_t daysFromCivil(int y, unsigned m, unsigned d) {
  y -= m <= 2;
  const int era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = (unsigned)(y - era * 400);
  const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return (int64_t)era * 146097 + (int64_t)doe - 719468;
}

inline uint32_t toUnix(int y, int mo, int d, int h, int mi, int s) {
  return (uint32_t)(daysFromCivil(y, mo, d) * 86400 + h * 3600 + mi * 60 + s);
}

}  // namespace net::state
