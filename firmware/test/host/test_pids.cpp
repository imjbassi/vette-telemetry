// The PID layer (src/pids.cpp) built for a PC: a stand-in Arduino core (shim/Arduino.h)
// and a scripted adapter in place of src/obd_ble.cpp. It covers what the engine gate
// relies on: RPM is never dropped, a silent ECU is asked for RPM only, one lost RPM
// reply costs nothing else, a skipped PID comes back within a minute, and the protocol
// search leaves the adapter on a fixed protocol or drops the link.
#include <functional>
#include <initializer_list>
#include <string>
#include <vector>
#include "check.h"
// The file under test, as one translation unit with this one, so its statics can be reset.
#include "../../src/pids.cpp"

// ---- the scripted adapter ----
static std::vector<std::string> g_sent;  // every command, in order
static std::function<std::string(const std::string&)> g_reply;
static int g_disconnects = 0;
static char g_proto = '7';

namespace obd {
String cmd(const char* c, uint32_t) {
  g_sent.push_back(c);
  return String(g_reply(c).c_str());
}
char protocol() { return g_proto; }
void setProtocol(char p) {
  if ((p >= '1' && p <= '9') || (p >= 'A' && p <= 'C')) g_proto = p;  // as in obd_ble.cpp
}
void disconnect() { g_disconnects++; }
}  // namespace obd

static int sentCount(const char* c) {
  int n = 0;
  for (auto& s : g_sent) n += s == c;
  return n;
}

// A warm engine at 2000 rpm. PIDs 05, 0C, 0D, 0F, 10 and 11, no further mask range.
static std::string running(const std::string& c) {
  if (c == "0100") return "4100081B8000";
  if (c == "010C1") return "410C1F40";
  if (c == "010D1") return "410D58";
  if (c == "01101") return "411004D2";
  if (c == "01111") return "41113A";
  if (c == "01051") return "41057D";
  if (c == "010F1") return "410F41";
  if (c.rfind("AT", 0) == 0) return "OK";
  return "NO DATA";
}

static const uint16_t kFast = V_RPM | V_SPEED | V_MAF | V_THROTTLE | V_COOLANT | V_INTAKE;

static void fresh() {
  g_millis = 10000;
  pids::reset();
  pids::s_searched = false;
  g_sent.clear();
  g_disconnects = 0;
  g_proto = '7';
}

// The ECU answers NO DATA to everything for a while (a short stop, or a few seconds of
// silence while driving), then answers again. The old code dropped all six fast PIDs
// after three such ticks and asked nothing more, RPM included, until the gate had gone
// quiet and come back.
static void rpmIsNeverDropped() {
  fresh();
  g_reply = [](const std::string&) { return std::string("NO DATA"); };
  for (int tick = 0; tick < 10; tick++) {
    Record r = {};
    pids::pollFast(r);
    CHECK_EQ(r.valid, 0);
  }
  // One request per tick, RPM, and nothing after it.
  CHECK_EQ(g_sent.size(), 10);
  CHECK_EQ(sentCount("010C1"), 10);

  g_sent.clear();
  g_reply = running;
  Record r = {};
  pids::pollFast(r);
  CHECK_EQ(r.valid, kFast);  // everything is back on the first tick with RPM
  CHECK_EQ(r.rpm, 2000);
  CHECK_EQ(r.speed_kph, 88);
  CHECK_EQ(g_sent.size(), 6);
}

// The same with timeouts instead of NO DATA: an empty reply.
static void noRpmNoOtherRequests() {
  fresh();
  g_reply = [](const std::string&) { return std::string(); };
  for (int tick = 0; tick < 5; tick++) {
    Record r = {};
    pids::pollFast(r);
    CHECK_EQ(r.valid, 0);
  }
  CHECK_EQ(g_sent.size(), 5);
  CHECK_EQ(sentCount("010C1"), 5);

  // RPM 0 is a reply (ignition on, engine off). The other PIDs are asked as before.
  fresh();
  g_reply = [](const std::string& c) { return c == "010C1" ? std::string("410C0000") : running(c); };
  Record r = {};
  pids::pollFast(r);
  CHECK_EQ(r.valid, kFast);
  CHECK_EQ(r.rpm, 0);
}

// The strike rule still holds for every other PID: three NO DATA in a row with RPM
// answering, and it is not asked again in this session.
static void otherPidsAreStillDropped() {
  fresh();
  g_reply = [](const std::string& c) { return c == "010D1" ? std::string("NO DATA") : running(c); };
  for (int tick = 0; tick < 8; tick++) {
    Record r = {};
    pids::pollFast(r);
    CHECK_EQ(r.valid, kFast & ~V_SPEED);
  }
  CHECK_EQ(sentCount("010D1"), 3);
  CHECK_EQ(sentCount("010C1"), 8);
}

// One poll at second s after start, as tick() makes it while active. Returns the
// number of requests it sent.
static size_t pollAt(uint32_t start, int s, Record& r) {
  g_millis = start + (uint32_t)s * 1000;
  size_t before = g_sent.size();
  pids::pollFast(r);
  return g_sent.size() - before;
}

// One RPM reply is lost between good ones (a timeout, or NO DATA under adaptive timing).
// The old code asked nothing else in that tick: the record had no speed and no airflow,
// and the backend counted no distance and no fuel for that second.
static void oneLostRpmReplyKeepsTheRest() {
  static int lostFrom, lostTo;  // ticks in which 010C gets no answer
  static bool silent;           // and the other PIDs neither
  fresh();
  lostFrom = 2;
  lostTo = 3;
  silent = false;
  static int tick;
  g_reply = [](const std::string& c) {
    if (tick >= lostFrom && tick < lostTo && (silent || c == "010C1")) return std::string("NO DATA");
    return running(c);
  };
  uint32_t t0 = g_millis;
  for (tick = 0; tick < 5; tick++) {
    Record r = {};
    size_t sent = pollAt(t0, tick, r);
    CHECK_EQ(sent, 6);
    CHECK_EQ(r.valid, tick == 2 ? kFast & ~V_RPM : kFast);
    CHECK_EQ(r.speed_kph, 88);
  }

  // Two lost in a row while the other PIDs answer: the second tick asks RPM only.
  fresh();
  lostFrom = 2;
  lostTo = 4;
  t0 = g_millis;
  for (tick = 0; tick < 6; tick++) {
    Record r = {};
    size_t sent = pollAt(t0, tick, r);
    CHECK_EQ(sent, tick == 3 ? 1 : 6);
    CHECK_EQ(r.valid, tick == 2 ? kFast & ~V_RPM : tick == 3 ? 0 : kFast);
  }

  // A real stop: the ECU goes silent. One round of the others in the first tick, then
  // RPM only. That round leaves one NO DATA strike per PID, so they all come back.
  fresh();
  lostFrom = 2;
  lostTo = 30;
  silent = true;
  t0 = g_millis;
  for (tick = 0; tick < 32; tick++) {
    Record r = {};
    size_t sent = pollAt(t0, tick, r);
    CHECK_EQ(sent, tick > 2 && tick < 30 ? 1 : 6);
    CHECK_EQ(r.valid, tick >= 2 && tick < 30 ? 0 : kFast);
  }
}

// The 0100 reply lists the other fast PIDs but not 0C, as when the ECM's line is lost and
// another module's mask arrives. RPM was refused by the mask, so active mode sent
// nothing at all and the gate went quiet on a running engine.
static void rpmIgnoresTheSupportMask() {
  fresh();
  g_reply = [](const std::string& c) { return c == "0100" ? std::string("4100080B8000") : running(c); };
  CHECK(pids::probe());
  for (int tick = 0; tick < 3; tick++) {
    Record r = {};
    pids::pollFast(r);
    CHECK_EQ(r.valid, kFast);
    CHECK_EQ(r.rpm, 2000);
  }
  CHECK_EQ(sentCount("010C1"), 3);

  // The mask still decides for every other PID: this one lacks 11 (throttle).
  fresh();
  g_reply = [](const std::string& c) { return c == "0100" ? std::string("4100081B0000") : running(c); };
  CHECK(pids::probe());
  Record r = {};
  pids::pollFast(r);
  CHECK_EQ(r.valid, kFast & ~V_THROTTLE);
  CHECK_EQ(sentCount("01111"), 0);
}

// Seen on the car with the old firmware: the ECU answered NO DATA in the first seconds
// of a drive, the PIDs were dropped for the session, and 16 minutes of driving had no
// speed, airflow, temperatures, fuel or odometer. Now the strikes are cleared once a
// minute while polling, and a skipped PID is back within 60 s.
static void skippedPidComesBackWithinAMinute() {
  fresh();
  g_reply = [](const std::string& c) {
    if (c == "0100") return std::string("4100081B8001");  // the 0D range, and 0120 follows
    if (c == "0120") return std::string("412000020000");  // 2F (fuel level)
    if (c == "010D1" && sentCount("010D1") <= 3) return std::string("NO DATA");
    if (c == "012F1") return std::string(sentCount("012F1") <= 3 ? "NO DATA" : "412FBF");
    return running(c);
  };
  CHECK(pids::probe());  // activation: the masks, and the minute starts
  uint32_t t0 = g_millis;
  int speedBack = -1, fuelBack = -1;
  uint32_t cycle = 0;
  for (int s = 0; s < 120; s++) {
    Record r = {};
    pollAt(t0, s, r);
    // The slow round every 10th tick with RPM, as tick() runs it.
    if ((r.valid & V_RPM) && cycle++ % SLOW_EVERY_N == 0) pids::pollSlow(r);
    else pids::carrySlow(r);
    CHECK(r.valid & V_RPM);
    if (s >= 3 && s < 60) CHECK(!(r.valid & V_SPEED));  // skipped
    if ((r.valid & V_SPEED) && speedBack < 0) speedBack = s;
    if ((r.valid & V_FUEL) && fuelBack < 0) fuelBack = s;
  }
  CHECK_EQ(speedBack, 60);
  CHECK_EQ(fuelBack, 60);
  CHECK_EQ(sentCount("010D1"), 3 + 60);  // ticks 0 to 2, then 60 to 119
  CHECK_EQ(sentCount("012F1"), 3 + 6);   // ticks 0, 10, 20, then 60 to 110

  // A PID the car never answers costs at most 3 requests a minute, and the others keep
  // coming. Then the engine stops at 650 s and the ECU goes silent. The minute that ends
  // at 660 s while the gate waits out its 20 s adds no request: RPM only, one per tick.
  fresh();
  static bool stopped;
  stopped = false;
  g_reply = [](const std::string& c) {
    if (stopped || c == "010D1") return std::string("NO DATA");
    return running(c);
  };
  CHECK(pids::probe());
  t0 = g_millis;
  for (int s = 0; s < 650; s++) {
    Record r = {};
    pollAt(t0, s, r);
    CHECK_EQ(r.valid, kFast & ~V_SPEED);
    if (s == 599) {
      CHECK_EQ(sentCount("010D1"), 3 * 10);
      CHECK_EQ(sentCount("010C1"), 600);
    }
  }
  stopped = true;
  for (int s = 650; s < 670; s++) {
    Record r = {};
    size_t sent = pollAt(t0, s, r);
    CHECK_EQ(sent, s == 650 ? 5 : 1);  // one round of the others, 0D still skipped
    CHECK_EQ(r.valid, 0);
  }
}

// The search finds nothing. The adapter must end up on the stored protocol, confirmed.
static void searchRestoresTheProtocol() {
  auto silentCar = [](const std::string& c) { return c.rfind("AT", 0) == 0 ? std::string("OK") : std::string("UNABLE TO CONNECT"); };

  fresh();
  g_reply = silentCar;
  CHECK(!pids::searchProtocol());
  CHECK_EQ(g_sent.size(), 3);
  if (g_sent.size() == 3) {
    CHECK(g_sent[0] == "ATSP0");
    CHECK(g_sent[1] == "0100");
    CHECK(g_sent[2] == "ATSP7");
  }
  CHECK_EQ(g_disconnects, 0);
  CHECK(!pids::searchProtocol());  // once per boot
  CHECK_EQ(g_sent.size(), 3);

  // The restore is not confirmed: no reply, or the adapter says something else. The
  // link is dropped, so the reconnect sets the protocol from a clean ATZ.
  for (const char* answer : {"", "STOPPED", "?"}) {
    fresh();
    g_reply = [&](const std::string& c) { return c == "ATSP7" ? std::string(answer) : silentCar(c); };
    CHECK(!pids::searchProtocol());
    CHECK_EQ(sentCount("ATSP7"), 1);
    CHECK_EQ(g_disconnects, 1);
  }
}

// The search finds a protocol.
static void searchFindsAProtocol() {
  // ATDPN says A6: protocol 6 is saved and set, and the adapter confirms it.
  fresh();
  g_reply = [](const std::string& c) { return c == "ATDPN" ? std::string("A6") : running(c); };
  CHECK(pids::searchProtocol());
  CHECK_EQ(g_proto, '6');
  CHECK(!g_sent.empty() && g_sent.back() == "ATSP6");
  CHECK_EQ(g_disconnects, 0);

  // ATDPN is not understood. The old code then sent no ATSP at all and left the adapter
  // on automatic. Now the stored protocol is set again.
  for (const char* dpn : {"", "?", "A0", "AUTO"}) {
    fresh();
    g_reply = [&](const std::string& c) { return c == "ATDPN" ? std::string(dpn) : running(c); };
    CHECK(pids::searchProtocol());
    CHECK_EQ(g_proto, '7');
    CHECK(!g_sent.empty() && g_sent.back() == "ATSP7");
    CHECK_EQ(sentCount("ATSP0"), 1);
    CHECK_EQ(g_disconnects, 0);
  }

  // Found, but the adapter does not confirm the new protocol: drop the link.
  fresh();
  g_reply = [](const std::string& c) {
    if (c == "ATDPN") return std::string("A6");
    if (c == "ATSP6") return std::string();
    return running(c);
  };
  CHECK(pids::searchProtocol());
  CHECK_EQ(g_disconnects, 1);
}

int main() {
  rpmIsNeverDropped();
  noRpmNoOtherRequests();
  otherPidsAreStillDropped();
  oneLostRpmReplyKeepsTheRest();
  rpmIgnoresTheSupportMask();
  skippedPidComesBackWithinAMinute();
  searchRestoresTheProtocol();
  searchFindsAProtocol();
  return finish("test_pids");
}
