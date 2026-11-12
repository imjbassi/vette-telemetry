// GNSS coordinate text to degrees * 1e7 (include/coord.h). The modem sends plain decimal
// degrees on the SIM7670G and NMEA ddmm.mmmm on older A76xx firmware.
#include <cstdlib>
#include "check.h"
#include "coord.h"

// The conversion goes through double and cuts off instead of rounding, so allow the last
// digit to differ. One unit is about a centimetre.
static bool closeTo(int32_t got, int32_t want, int tol = 2) {
  if (std::labs((long)got - (long)want) <= tol) return true;
  std::printf("  got %ld, want %ld\n", (long)got, (long)want);
  return false;
}

int main() {
  // Decimal degrees, all four hemispheres.
  CHECK(closeTo(coordToE7("37.819900", false, true), 378199000));
  CHECK(closeTo(coordToE7("37.819900", true, true), -378199000));
  CHECK(closeTo(coordToE7("122.478300", true, false), -1224783000));
  CHECK(closeTo(coordToE7("122.478300", false, false), 1224783000));

  // NMEA ddmm.mmmm and dddmm.mmmm for the same place: 37 deg 49.194 min, 122 deg 28.698 min.
  CHECK(closeTo(coordToE7("3749.1940", false, true), 378199000));
  CHECK(closeTo(coordToE7("3749.1940", true, true), -378199000));
  CHECK(closeTo(coordToE7("12228.6980", true, false), -1224783000));
  CHECK(closeTo(coordToE7("12228.6980", false, false), 1224783000));

  // The sample from older A76xx firmware quoted in net_modem.cpp.
  CHECK(closeTo(coordToE7("3113.330650", false, true), 312221775));
  CHECK(closeTo(coordToE7("12121.262554", false, false), 1213543759));

  // Near the equator and the prime meridian the digit count is what tells the formats apart.
  CHECK(closeTo(coordToE7("0.500000", false, true), 5000000));
  CHECK(closeTo(coordToE7("0030.0000", false, true), 5000000));      // 0 deg 30 min
  CHECK(closeTo(coordToE7("2.350000", false, false), 23500000));
  CHECK(closeTo(coordToE7("00221.0000", false, false), 23500000));   // 2 deg 21 min
  CHECK(closeTo(coordToE7("9.5", true, false), -95000000));
  CHECK(closeTo(coordToE7("89.999999", false, true), 899999990, 10));
  CHECK(closeTo(coordToE7("179.999999", true, false), -1799999990, 10));

  // Latitude counts as NMEA from four digits before the point, longitude from five.
  CHECK(closeTo(coordToE7("0959.0000", false, true), 99833333));     // lat: 9 deg 59 min
  CHECK(closeTo(coordToE7("00959.0000", false, false), 99833333));   // lon: 9 deg 59 min

  // No decimal point, empty and missing text.
  CHECK(closeTo(coordToE7("37", false, true), 370000000));
  CHECK(closeTo(coordToE7("3730", false, true), 375000000));         // 37 deg 30 min
  CHECK_EQ(coordToE7("", false, true), 0);
  CHECK_EQ(coordToE7(nullptr, true, false), 0);

  return finish("test_coord");
}
