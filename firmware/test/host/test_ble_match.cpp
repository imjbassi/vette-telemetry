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

// The scan stops at the first result that settles it (blematch::settles), the way the scan
// callback in src/obd_ble.cpp does. Results come in the order their callbacks run. Index of
// the result taken, -1 = none.
static int pickStopping(const std::vector<Seen>& scan, bool anyPaired) {
  int best = 0, at = -1;
  for (size_t i = 0; i < scan.size(); i++) {
    int r = blematch::rank(scan[i].paired, scan[i].named, scan[i].fff0, anyPaired);
    if (r > best) {
      best = r;
      at = (int)i;
    }
    if (blematch::settles(r, anyPaired)) break;
  }
  return at;
}

// Stopping early takes the same result a full scan takes, unless two results can settle it.
static void stopsEarly() {
  static_assert(blematch::settles(4, true) && blematch::settles(3, true));
  static_assert(!blematch::settles(2, true) && !blematch::settles(1, true) && !blematch::settles(0, true));
  static_assert(blematch::settles(2, false));
  static_assert(!blematch::settles(1, false) && !blematch::settles(0, false));
  // Paired: the scan stops at our adapter, whatever came before it.
  CHECK_EQ(pickStopping({{true, true, true}, {false, true, true}}, true), 0);
  CHECK_EQ(pickStopping({{false, true, true}, {true, false, true}, {false, true, false}}, true), 1);
  CHECK_EQ(pickStopping({{false, false, true}, {true, false, false}}, true), 1);
  // Another car's OBDLink alone does not stop it while a pairing is stored: ours may come later.
  CHECK_EQ(pickStopping({{false, true, true}, {false, false, true}, {true, true, true}}, true), 2);
  CHECK_EQ(pickStopping({{false, true, false}}, true), 0);  // the scan ran out, the name is taken as before
  // Nothing paired: the name settles it, FFF0 alone does not.
  CHECK_EQ(pickStopping({{false, false, true}, {false, true, false}, {false, true, true}}, false), 1);
  CHECK_EQ(pickStopping({{false, false, true}}, false), 0);
  // Every scan of the tests above and of pairedAdapter() and firstPairing() with at most one
  // result that settles it: stopping early takes the very result a full scan takes.
  const std::vector<std::vector<Seen>> scans = {
      {{true, false, true}}, {{true, false, false}}, {{true, true, true}}, {{false, true, true}},
      {{false, true, true}, {true, false, true}}, {{false, true, true}, {true, true, true}},
      {{false, false, true}}, {{false, false, true}, {true, false, false}}, {{false, true, false}},
      {{false, false, true}, {false, true, false}}, {{false, false, false}}, {},
      {{true, true, true}, {false, true, true}}, {{false, true, true}, {true, false, true}, {false, true, false}},
      {{false, true, true}, {false, false, true}, {true, true, true}}};
  int compared = 0;
  for (bool anyPaired : {true, false}) {
    for (const auto& s : scans) {
      // A paired result while nothing is paired cannot happen.
      bool paired = false;
      int settling = 0;
      for (const auto& x : s) {
        paired = paired || x.paired;
        settling += blematch::settles(blematch::rank(x.paired, x.named, x.fff0, anyPaired), anyPaired);
      }
      if ((paired && !anyPaired) || settling > 1) continue;
      CHECK_EQ(pickStopping(s, anyPaired), pick(s, anyPaired));
      compared++;
    }
  }
  CHECK_EQ(compared, 21);
  // Two results that settle it: the scan stops at the first one, which a full scan can pass
  // over. Two paired adapters where the first is heard without its name: the full scan takes
  // the second, with its name, the early stop the first.
  CHECK_EQ(pick({{true, false, true}, {true, true, true}}, true), 1);
  CHECK_EQ(pickStopping({{true, false, true}, {true, true, true}}, true), 0);
  // Two OBDLink names while nothing is paired, reported in this order: both take the first.
  CHECK_EQ(pick({{false, true, true}, {false, true, false}}, false), 0);
  CHECK_EQ(pickStopping({{false, true, true}, {false, true, false}}, false), 0);
  // Should NimBLE report the second one's scan response first, the early stop takes that one
  // ({false, true, false}), where the full scan takes the first one heard ({false, true, true}).
  const std::vector<Seen> reported = {{false, true, false}, {false, true, true}};
  int early = pickStopping(reported, false);
  CHECK_EQ(early, 0);
  CHECK(!reported[early].fff0);
}

int main() {
  pairedAdapter();
  firstPairing();
  stopsEarly();
  return finish("test_ble_match");
}
