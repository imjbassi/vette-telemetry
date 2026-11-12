// Which scan result is the adapter (include/ble_match.h). pick() goes through one scan
// the way connect() in src/obd_ble.cpp does: highest rank wins, the first one seen wins a tie.
#include <vector>
#include "ble_match.h"
#include "check.h"

struct Seen {
  bool paired, named, fff0;
};

// Index of the result to connect to, -1 = none.
static int pick(const std::vector<Seen>& scan, bool anyPaired) {
  int best = 0, at = -1;
  for (size_t i = 0; i < scan.size(); i++) {
    int r = blematch::rank(scan[i].paired, scan[i].named, scan[i].fff0, anyPaired);
    if (r > best) {
      best = r;
      at = (int)i;
    }
  }
  return at;
}

// The car board after the flash: its pairing with the CX is stored.
static void pairedAdapter() {
  // The scan heard the CX's advert (FFF0) but not its scan response, so there is no
  // name. This is the paired adapter and it must be connected. The rule before this
  // one ignored it and waited for the name, on every such scan.
  CHECK_EQ(pick({{true, false, true}}, true), 0);
  // Not even FFF0 in the advert: the address alone is enough.
  CHECK_EQ(pick({{true, false, false}}, true), 0);
  // With the name it is found as before.
  CHECK_EQ(pick({{true, true, true}}, true), 0);

  // Another car's OBDLink is heard first. The paired one is ours.
  CHECK_EQ(pick({{false, true, true}, {true, false, true}}, true), 1);
  CHECK_EQ(pick({{false, true, true}, {true, true, true}}, true), 1);
  // A paired device with the name beats a paired device without it.
  CHECK_EQ(pick({{true, false, true}, {true, true, true}}, true), 1);
  // Of two equal results the first one seen is taken.
  CHECK_EQ(pick({{true, false, true}, {true, false, true}}, true), 0);

  // A stray FFF0 device that is not paired is never connected while a pairing is stored.
  CHECK_EQ(pick({{false, false, true}}, true), -1);
  CHECK_EQ(pick({{false, false, true}, {true, false, false}}, true), 1);
  // A new CX (the name, not paired) can still be paired while an old pairing is stored.
  CHECK_EQ(pick({{false, true, false}}, true), 0);
}

// Nothing is paired yet: first contact, or after "unpair" or a flash erase.
static void firstPairing() {
  CHECK_EQ(pick({{false, true, true}}, false), 0);
  CHECK_EQ(pick({{false, false, true}}, false), 0);  // FFF0 alone is accepted now
  CHECK_EQ(pick({{false, false, true}, {false, true, false}}, false), 1);  // but the name is preferred
  CHECK_EQ(pick({{false, false, false}}, false), -1);
  CHECK_EQ(pick({}, false), -1);
}

int main() {
  pairedAdapter();
  firstPairing();
  return finish("test_ble_match");
}
