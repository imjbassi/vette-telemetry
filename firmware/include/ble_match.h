#pragma once

// Which Bluetooth scan result is the OBD adapter. Plain C++17 with no Arduino or NimBLE
// headers, so test/host/test_ble_match.cpp can check it. src/obd_ble.cpp collects the
// facts about each scan result and connects to the one with the highest rank.

namespace blematch {

// Rank of one scan result. Higher wins, 0 = not the adapter.
//   paired:    its address belongs to a stored pairing (and is not the null address)
//   named:     its name starts with OBDLink
//   fff0:      it advertises the generic FFF0 service
//   anyPaired: a pairing is stored at all
//
// A stored pairing is the best proof. It is the address the adapter was paired on, and
// connecting to it encrypts with the stored key and starts no new pairing. The name is
// only seen when the adapter's scan response was heard, so a paired adapter must not
// depend on it. A name without a pairing comes next: that is the first pairing, or a
// new adapter. A bare FFF0 advertiser could be anybody's, and connecting to it starts a
// pairing that can push the adapter's own out of the three-slot store. It is accepted
// only while nothing is paired.
constexpr int rank(bool paired, bool named, bool fff0, bool anyPaired) {
  if (paired && named) return 4;
  if (paired) return 3;
  if (named) return 2;
  if (fff0 && !anyPaired) return 1;
  return 0;
}

}  // namespace blematch
