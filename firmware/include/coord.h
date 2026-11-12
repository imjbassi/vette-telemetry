#pragma once
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

// GNSS coordinate text to degrees * 1e7. No Arduino types, so test/host/test_coord.cpp
// can run it on a PC.
//
// Coordinates arrive either as NMEA ddmm.mmmm / dddmm.mmmm or, on the SIM7670G, as plain
// decimal degrees (37.819900 / 122.478300). Tell them apart by the digits before the point:
// NMEA always has 4 (lat) or 5 (lon), decimal degrees at most 2 or 3.
// negative = the hemisphere letter is S or W.
inline int32_t coordToE7(const char* text, bool negative, bool isLat) {
  if (!text) text = "";  // an empty Arduino String can hand out a null pointer
  const char* dot = strchr(text, '.');
  int intDigits = dot ? (int)(dot - text) : (int)strlen(text);
  double raw = strtod(text, nullptr);
  double dec;
  if (intDigits >= (isLat ? 4 : 5)) {
    int deg = (int)(raw / 100);
    dec = deg + (raw - deg * 100) / 60.0;
  } else {
    dec = raw;
  }
  return (int32_t)((negative ? -dec : dec) * 1e7);
}
