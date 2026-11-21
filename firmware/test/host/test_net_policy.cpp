// The network decisions of include/net_policy.h: upload size, the wait after a refusal,
// and when to set the modem up again. Fed with the results uploadPass() in src/main.cpp
// and at() in src/net_modem.cpp would give them.
#include <initializer_list>
#include <string>
#include "check.h"
#include "config.h"
#include "net_policy.h"

static const size_t kFull = MAX_UPLOAD_BYTES;         // 16384
static const size_t kSmall = UPLOAD_FALLBACK_BYTES;   // 1440
static const size_t kSegment = 341 * 48;              // a full segment
static const size_t kLive = 15 * 48;                  // a normal 15 s upload

static netpol::UploadPolicy make() {
  return netpol::UploadPolicy(MAX_UPLOAD_BYTES, UPLOAD_FALLBACK_BYTES, UPLOAD_PERIOD_MS * 2, UPLOAD_MAX_WAIT_MS);
}

static_assert(UPLOAD_FALLBACK_BYTES % 48 == 0, "the fallback body is whole records");
static_assert(UPLOAD_FALLBACK_BYTES <= 62 * 48, "no larger than the largest upload proven on the car");
static_assert(netpol::bodyRelated(400) && netpol::bodyRelated(413) && netpol::bodyRelated(503) && netpol::bodyRelated(599));
static_assert(netpol::bodyRelated(-4) && netpol::bodyRelated(-5));
static_assert(!netpol::bodyRelated(200) && !netpol::bodyRelated(399) && !netpol::bodyRelated(600));
static_assert(!netpol::bodyRelated(-1) && !netpol::bodyRelated(-2) && !netpol::bodyRelated(-3));
static_assert(!netpol::bodyRelated(-6) && !netpol::bodyRelated(-7) && !netpol::bodyRelated(706));

// HTTP 400 to 599: the wait doubles from 30 s to 5 minutes and ends with a 2xx.
static void refusalBackoff() {
  auto p = make();
  CHECK_EQ(p.waitMs(), 0);
  const uint32_t want[] = {30000, 60000, 120000, 240000, 300000, 300000};
  for (uint32_t w : want) {
    p.onPost(kLive, 503);
    CHECK_EQ(p.waitMs(), w);
  }
  p.onPost(kLive, 200);
  CHECK_EQ(p.waitMs(), 0);
  p.onPost(kLive, 422);
  CHECK_EQ(p.waitMs(), 30000);
  // A timeout or a modem error neither starts a wait nor ends one.
  p.onPost(kLive, -7);
  p.onPost(kLive, 706);
  CHECK_EQ(p.waitMs(), 30000);
  auto q = make();
  q.onPost(kLive, -7);
  q.onPost(kLive, 715);
  CHECK_EQ(q.waitMs(), 0);
}

// 20 minutes of 503 bring the wait to 5 minutes. Then the server accepts again, but the
// second upload of every pass times out. The pass used to report only its last result,
// so the accepted upload never ended the wait.
static void acceptedUploadEndsTheWait() {
  auto p = make();
  for (int i = 0; i < 8; i++) p.onPost(kLive, 503);
  CHECK_EQ(p.waitMs(), 300000);
  p.onPost(kLive, 200);
  p.onPost(kLive, -7);
  CHECK_EQ(p.waitMs(), 0);
  // A refusal later in the same pass starts again at 30 s.
  p.onPost(kLive, 200);
  p.onPost(kLive, 503);
  CHECK_EQ(p.waitMs(), 30000);
}

// Full-size bodies keep being refused: after the third refusal uploads are 30 records.
static void fallbackToSmallBodies() {
  auto p = make();
  CHECK_EQ(p.bodyCap(), kFull);
  CHECK(!p.onPost(kSegment, 503));
  CHECK(!p.onPost(kSegment, 503));
  CHECK_EQ(p.bodyCap(), kFull);
  CHECK(p.onPost(kSegment, 503));  // the third one switches
  CHECK(p.smallBodies());
  CHECK_EQ(p.bodyCap(), kSmall);
  // For the rest of the boot, whatever happens next.
  CHECK(!p.onPost(kSmall, 200));
  CHECK(!p.onPost(kSmall, 503));
  CHECK(!p.onPost(kSmall, 200));
  CHECK_EQ(p.bodyCap(), kSmall);

  // The modem not taking the body counts the same (-4 and -5 from net::post()).
  auto m = make();
  m.onPost(kSegment, -4);
  m.onPost(kSegment, -5);
  CHECK(!m.smallBodies());
  CHECK(m.onPost(kSegment, -4));
  CHECK_EQ(m.bodyCap(), kSmall);
  CHECK_EQ(m.waitMs(), 0);  // no HTTP answer, so no extra wait before the small try

  // Any body over the fallback size counts, not only a full segment.
  auto h = make();
  h.onPost(kSmall + 48, 500);
  h.onPost(kSmall + 48, 500);
  CHECK(h.onPost(kSmall + 48, 500));
}

// What must not cause the fallback.
static void noFallbackWithoutCause() {
  // Timeouts and network errors in weak coverage, however many.
  auto p = make();
  for (int i = 0; i < 50; i++) {
    for (int code : {-7, 706, 715, -6, -3, -2, -1}) CHECK(!p.onPost(kSegment, code));
  }
  CHECK_EQ(p.bodyCap(), kFull);

  // They do not hide refusals either: three refusals with timeouts in between still switch.
  auto mix = make();
  mix.onPost(kSegment, 503);
  mix.onPost(kSegment, -7);
  mix.onPost(kSegment, 503);
  mix.onPost(kSegment, -7);
  CHECK(!mix.smallBodies());
  CHECK(mix.onPost(kSegment, 503));

  // An accepted large body starts the count again.
  auto r = make();
  r.onPost(kSegment, 503);
  r.onPost(kSegment, 503);
  r.onPost(kSegment, 200);
  r.onPost(kSegment, 503);
  r.onPost(kSegment, 503);
  CHECK_EQ(r.bodyCap(), kFull);
  CHECK(r.onPost(kSegment, 503));

  // Refused small bodies say nothing about large ones: a server that is simply down
  // while only live uploads are waiting changes nothing.
  auto s = make();
  for (int i = 0; i < 20; i++) CHECK(!s.onPost(kLive, 503));
  CHECK(!s.onPost(kSmall, 503));
  CHECK_EQ(s.bodyCap(), kFull);
  // And an accepted small body does not clear refusals of large ones.
  s.onPost(kSegment, 503);
  s.onPost(kSegment, 503);
  s.onPost(kLive, 200);
  CHECK(s.onPost(kSegment, 503));
}

// ---- upload diagnostics ----

// One POST the way uploadPass() in src/main.cpp makes it: the query, then its result.
// Returns the query the POST carried.
static std::string send(netpol::UploadDiag& d, size_t bytes, int code, uint32_t now) {
  char buf[netpol::UploadDiag::kQueryMax];
  std::string sent = d.query(buf, now);
  d.onPost(bytes, code, now);
  return sent;
}
// The report as it stands, whether or not the next POST may carry it.
static std::string report(const netpol::UploadDiag& d, uint32_t now) {
  char buf[netpol::UploadDiag::kQueryMax];
  return d.report(buf, now);
}

// The first upload after power-up says how long the data link took, then nothing while
// uploads go through on time.
static void diagFirstUploadThenQuiet() {
  netpol::UploadDiag d;
  uint32_t t = 0;
  for (; t < 40000; t += 250) d.onTick(false, t);  // 40 s until the modem has a data link
  for (; t < 45000; t += 250) d.onTick(true, t);
  CHECK(send(d, 720, 200, t) == "?f=0&g=45&d=40&b=1");
  CHECK(report(d, t) == "");
  // 15 s later, and a parked 60 s later: nothing to say.
  for (; t < 60000; t += 250) d.onTick(true, t);
  CHECK(send(d, 720, 200, t) == "");
  CHECK(report(d, t + 60000) == "");
  // Gaps over 3 minutes are said, with the largest body accepted since power-up.
  CHECK(report(d, t + 180001) == "?f=0&g=180&d=0&a=720");
  CHECK(report(d, t + 180000) == "");
}

// The net task turn that ends an outage: its first tick sees the link down, service() brings
// it up, and the overdue upload goes through in the same turn. The next upload, on time,
// has nothing to say. Before this fixed it, it said the link had been down.
static void diagReconnectTurn() {
  for (bool secondTick : {true, false}) {
    netpol::UploadDiag d;
    uint32_t t = 0;
    for (; t < 10000; t += 250) d.onTick(true, t);
    CHECK(send(d, 720, 200, t) == "?f=0&g=10&d=0&b=1");
    for (; t <= 310000; t += 250) d.onTick(false, t);  // 5 minutes without a data link
    t += 2500;                                          // service() brings it up
    if (secondTick) d.onTick(true, t);                  // the tick right after service()
    // With the second tick the 2.5 s of bring-up count as down time. Without it the upload
    // still goes through, and its acceptance proves the link from then on.
    CHECK(send(d, 720, 200, t) == (secondTick ? "?f=0&g=302&d=302&a=720" : "?f=0&g=302&d=300&a=720"));
    t += 4000;  // the upload took 4 s
    for (uint32_t end = t + 15000; t < end; t += 250) d.onTick(true, t);
    CHECK(send(d, 720, 200, t) == "");
    // A backlog drained in the same turn is quiet too.
    CHECK(send(d, 16368, 200, t) == "");
  }
}

// 2026-11-20: 46 minutes without an accepted upload, then three failures. A try after one
// that carried the query goes without it, so a modem that cannot take the query in some
// other way still gets every other try through. Every failure is counted all the same.
static void diagOutage() {
  netpol::UploadDiag d;
  uint32_t t = 0;
  for (; t < 10000; t += 250) d.onTick(true, t);
  send(d, 720, 200, t);
  for (; t < 10000 + 2400000; t += 250) d.onTick(false, t);  // 40 minutes without a data link
  for (; t < 10000 + 2700000; t += 250) d.onTick(true, t);
  CHECK(send(d, 341 * 48, -4, t) == "?f=0&g=2700&d=2400&a=720");
  CHECK(send(d, 341 * 48, -4, t) == "");
  CHECK(send(d, 341 * 48, 503, t) == "?f=2&g=2700&d=2400&e=-4.2&a=720&r=16368");
  CHECK(send(d, 30 * 48, -7, t) == "");
  CHECK_EQ(d.fails(), 4);
  CHECK_EQ(d.downMs(), 2400000);
  // The small one carries it all and goes through, so the count starts again.
  CHECK(send(d, 30 * 48, 200, t) == "?f=4&g=2700&d=2400&e=-4.2,503.1,-7.1&a=720&r=16368");
  CHECK(report(d, t) == "");
  CHECK_EQ(d.fails(), 0);
  CHECK_EQ(d.downMs(), 0);
  // The largest accepted and the smallest refused body stay for the whole power-up.
  CHECK(report(d, t + 200000) == "?f=0&g=200&d=0&a=1440&r=16368");
}

// A try without the query that goes through leaves the report for the next upload, which
// says that one upload went without it (w).
static void diagWaitsForTheNextUpload() {
  netpol::UploadDiag d;
  d.onTick(true, 0);
  CHECK(send(d, 720, -7, 0) == "?f=0&g=0&d=0&b=1");
  CHECK(send(d, 720, 200, 60000) == "");
  CHECK(send(d, 720, 200, 75000) == "?f=1&g=75&d=0&b=1&w=1&e=-7.1&a=720");
  CHECK(send(d, 720, 200, 90000) == "");
  // 2026-11-20 again: the third refusal of a large body is a try that carried the report, so
  // the first small upload goes without it, and the one after it carries the report.
  netpol::UploadDiag o;
  uint32_t t = 0;
  for (; t < 10000; t += 250) o.onTick(true, t);
  send(o, 720, 200, t);
  for (; t < 10000 + 2400000; t += 250) o.onTick(false, t);  // 40 minutes without a data link
  for (; t < 10000 + 2700000; t += 250) o.onTick(true, t);
  CHECK(send(o, 341 * 48, -4, t) == "?f=0&g=2700&d=2400&a=720");
  CHECK(send(o, 341 * 48, -5, t) == "");
  CHECK(send(o, 341 * 48, -4, t) == "?f=2&g=2700&d=2400&e=-4.1,-5.1&a=720&r=16368");
  CHECK(send(o, 30 * 48, 200, t) == "");
  CHECK(send(o, 30 * 48, 200, t + 3000) == "?f=3&g=2703&d=2400&w=1&e=-4.2,-5.1&a=1440&r=16368");
  CHECK(report(o, t + 3000) == "");
  // An upload that had nothing to say when it went starts the count again, also when it
  // ends more than 3 minutes after the last one.
  netpol::UploadDiag q;
  q.onTick(true, 0);
  CHECK(send(q, 720, 200, 5000) == "?f=0&g=5&d=0&b=1");
  char buf[netpol::UploadDiag::kQueryMax];
  CHECK(std::string(q.query(buf, 180000)) == "");
  q.onPost(720, 200, 192000);  // the POST took 12 s
  CHECK(report(q, 240000) == "");
  CHECK(report(q, 192000 + 180001) == "?f=0&g=180&d=0&a=720");
  // A modem that takes the URL but fails every request with the query: uploads still go through.
  netpol::UploadDiag m;
  m.onTick(true, 0);
  int through = 0;
  for (uint32_t t = 0; t < 600000; t += 15000) {
    char buf[netpol::UploadDiag::kQueryMax];
    bool withQuery = m.query(buf, t)[0] != 0;
    int code = withQuery ? 715 : 200;
    m.onPost(720, code, t);
    through += code == 200;
  }
  CHECK_EQ(through, 20);  // every other try of 40
  CHECK(!m.off());
}

// The modem refuses the request setup with the query (-3): no query until the next power-up.
static void diagOffAfterSetupRefused() {
  netpol::UploadDiag d;
  d.onTick(true, 0);
  CHECK(send(d, 720, -3, 0) == "?f=0&g=0&d=0&b=1");
  CHECK(d.off());
  for (uint32_t i = 1; i <= 5; i++) CHECK(send(d, 720, -7, i * 1000) == "");
  // What could not be sent is dropped, so it does not pile up for the rest of the power-up.
  CHECK(send(d, 720, 200, 9000) == "");
  CHECK_EQ(d.fails(), 0);
  CHECK(report(d, 9000 + 400000) != "");
  CHECK(send(d, 720, 200, 9000 + 400000) == "");
  // A -3 on a try without the query says nothing about the query.
  netpol::UploadDiag e;
  e.onTick(true, 0);
  CHECK(send(e, 720, -7, 0) != "");
  CHECK(send(e, 720, -3, 1000) == "");
  CHECK(!e.off());
  CHECK(send(e, 720, 200, 2000) == "?f=2&g=2&d=0&b=1&e=-7.1,-3.1");
}

// Codes past the first four count as "x". Only codes the body can cause set the smallest refused body.
static void diagCodes() {
  netpol::UploadDiag d;
  d.onTick(true, 0);
  send(d, 720, 200, 0);
  for (int code : {-1, -1, -7, 706, -2, 715, 715, 503}) send(d, 4800, code, 1000);
  CHECK(report(d, 1000) == "?f=8&g=1&d=0&e=-1.2,-7.1,706.1,-2.1,x.3&a=720&r=4800");
  netpol::UploadDiag n;
  n.onPost(8000, -7, 0);
  n.onPost(8000, 706, 0);
  CHECK(report(n, 5000) == "?f=2&g=5&d=0&b=1&e=-7.1,706.1");  // no r: a timeout says nothing about the body
  n.onPost(9000, -5, 0);
  n.onPost(2000, 413, 0);
  CHECK(report(n, 5000) == "?f=4&g=5&d=0&b=1&e=-7.1,706.1,-5.1,413.1&r=2000");
}

// The size test: its accepted bodies count for a and as uploads, its failures only for r.
static void diagProbe() {
  netpol::UploadDiag d;
  d.onTick(true, 0);
  // Before the first upload of the power-up, every accepted body goes without the report.
  d.onProbe(30 * 48, 200, 1000);
  d.onProbe(62 * 48, 200, 2000);
  d.onProbe(100 * 48, -4, 3000);
  d.onProbe(170 * 48, -7, 4000);
  CHECK_EQ(d.fails(), 0);
  CHECK(send(d, 720, 200, 5000) == "?f=0&g=5&d=0&b=1&w=2&a=2976&r=4800");
  // With nothing to say, an accepted body starts the count again, like an upload on time.
  d.onProbe(341 * 48, 200, 100000);
  CHECK(report(d, 100000 + 180000) == "");
  CHECK(report(d, 100000 + 180001) == "?f=0&g=180&d=0&a=16368&r=4800");
  // While a report waits, it goes without it.
  d.onPost(720, -7, 110000);
  d.onProbe(30 * 48, 200, 120000);
  CHECK(send(d, 720, 200, 130000) == "?f=1&g=30&d=0&w=1&e=-7.1&a=16368&r=4800");
}

// The longest query there can be still fits, and the counters stop at their top.
static void diagLimits() {
  netpol::UploadDiag d;
  // More accepted uploads without the report than w holds, each after a try that carried it
  // and failed, so b stays too.
  for (int i = 0; i < 300; i++) {
    send(d, 65535, -32768, 0);
    send(d, 65535, 200, 0);
  }
  for (int c = 0; c < 4; c++) {
    for (int i = 0; i < 70000; i++) d.onPost(65535, -32768 + c, 0);
  }
  for (int i = 0; i < 70000; i++) d.onPost(65535, -999, 0);
  d.onPost(65535, 413, 0);
  d.onTick(false, 0);
  d.onTick(false, 0xFFFFFFFFu);
  std::string s = report(d, 0xFFFFFFFFu);
  CHECK(s == "?f=65535&g=4294967&d=4294967&b=1&w=255&e=-32768.65535,-32767.65535,-32766.65535,-32765.65535,x.65535&a=65535&r=65535");
  CHECK_EQ(s.size(), (size_t)116);
  CHECK(s.size() < netpol::UploadDiag::kQueryMax);
  // millis() wraps around between the last accepted upload and now.
  netpol::UploadDiag w;
  w.onTick(true, 0xFFFFFFFFu - 9999);
  CHECK(send(w, 720, 200, 0xFFFFFFFFu - 9999) == "?f=0&g=4294957&d=4294957&b=1");
  CHECK(report(w, 5000) == "");
  CHECK(report(w, 190000) == "?f=0&g=200&d=0&a=720");
}

// A valid fix with every count field empty keeps the last count.
static void fixSats() {
  static_assert(netpol::fixSats(9, 0) == 9);
  static_assert(netpol::fixSats(0, 9) == 9);
  static_assert(netpol::fixSats(0, 0) == 0);
  static_assert(netpol::fixSats(12, 9) == 12);
  static_assert(netpol::fixSats(300, 9) == 255);
  static_assert(netpol::fixSats(-3, 7) == 7);
  CHECK(true);
}

// The modem restarted and echoes again.
static void modemRestart() {
  netpol::RestartWatch w;
  CHECK(!w.due(0));
  CHECK(!w.due(500000));

  // Seen 10 s after boot: applied at once, not held back by the one minute rule.
  w.onEcho();
  CHECK(w.seen());
  CHECK(w.due(10000));
  // The modem is still starting up and refuses GNSS power: tried again a minute later.
  w.applied(10000, false);
  CHECK(w.seen());
  CHECK(!w.due(10001));
  CHECK(!w.due(69999));
  CHECK(w.due(70000));
  // ATE0 is echoed once during the re-apply. Accepted this time: done.
  w.onEcho();
  w.applied(70000, true);
  CHECK(!w.seen());
  CHECK(!w.due(70000 + 10 * 60000));

  // A modem that keeps echoing (ATE0 not honored) gets the settings once a minute, not
  // on every 250 ms turn of the net task.
  uint32_t now = 200000;
  int applied = 0;
  for (int turn = 0; turn < 4 * 600; turn++, now += 250) {  // ten minutes
    w.onEcho();
    if (w.due(now)) {
      applied++;
      w.onEcho();
      w.applied(now, true);
    }
  }
  CHECK(applied >= 9 && applied <= 11);

  // begin() has just set everything: the echo of its first command is forgotten.
  netpol::RestartWatch b;
  b.onEcho();
  b.clear();
  CHECK(!b.due(1000));

  // millis() wraps around between two tries.
  netpol::RestartWatch x;
  x.onEcho();
  x.applied(0xFFFFFFFFu - 20000, false);
  CHECK(!x.due(0xFFFFFFFFu));
  CHECK(!x.due(30000));
  CHECK(x.due(40000));
}

int main() {
  refusalBackoff();
  acceptedUploadEndsTheWait();
  fallbackToSmallBodies();
  noFallbackWithoutCause();
  diagFirstUploadThenQuiet();
  diagReconnectTurn();
  diagOutage();
  diagWaitsForTheNextUpload();
  diagOffAfterSetupRefused();
  diagCodes();
  diagProbe();
  diagLimits();
  fixSats();
  modemRestart();
  return finish("test_net_policy");
}
