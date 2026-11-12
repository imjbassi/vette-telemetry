// The network decisions of include/net_policy.h: upload size, the wait after a refusal,
// and when to set the modem up again. Fed with the results uploadPass() in src/main.cpp
// and at() in src/net_modem.cpp would give them.
#include <initializer_list>
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
static_assert(UPLOAD_FALLBACK_BYTES <= 31 * 48, "no larger than the largest upload proven on the car");
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
  modemRestart();
  return finish("test_net_policy");
}
