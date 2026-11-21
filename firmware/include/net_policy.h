#pragma once
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

// Network decisions that need no hardware: how large an upload may be, how long to wait
// after a refusal, and when to set the modem up again. Plain C++17 with no Arduino
// headers, so test/host/test_net_policy.cpp runs them on a PC. src/main.cpp and
// src/net_modem.cpp feed them results and act on what they say.

namespace netpol {

// ---- Upload size and wait ----

constexpr uint8_t kBodyRefusals = 3;  // refused full-size uploads in a row before the fallback to small ones

// True when the size of the body can be why an upload failed: the server answered and
// said no (HTTP 400 to 599), or the modem did not take the body (-4 and -5 from
// net::post() in net_modem.cpp). A timeout or a network error (-7, 700 and up) says
// nothing about the body. Three of those in weak coverage must not turn every later
// backlog into small uploads, each with its own TLS handshake.
constexpr bool bodyRelated(int code) { return (code >= 400 && code <= 599) || code == -4 || code == -5; }

// The queue is sent oldest first, and an upload that fails is sent again unchanged. A
// full segment is one 16 KB body, and nothing that large has gone through the real modem
// and Worker yet. If such a body cannot get through, nothing newer would ever be
// uploaded. So after three refusals in a row of a body larger than the fallback size,
// uploads use the fallback size for the rest of the boot. The queue then hands a
// segment out in pieces.
class UploadPolicy {
 public:
  UploadPolicy(size_t fullBytes, size_t smallBytes, uint32_t firstWaitMs, uint32_t maxWaitMs)
      : m_fullBytes(fullBytes), m_smallBytes(smallBytes), m_firstWaitMs(firstWaitMs), m_maxWaitMs(maxWaitMs) {}

  // Largest body to ask the queue for.
  size_t bodyCap() const { return m_small ? m_smallBytes : m_fullBytes; }
  bool smallBodies() const { return m_small; }

  // Extra wait before the next upload pass. 0 = the last answer was fine.
  uint32_t waitMs() const { return m_waitMs; }

  // Call with the result of every POST. True when this result caused the fallback.
  bool onPost(size_t bodyBytes, int code) {
    bool ok = code >= 200 && code < 300;
    // The server answered and said no: the same batch at the normal pace would only burn
    // data and the Worker's daily quota, so the wait doubles with every refusal. Any
    // accepted upload ends it, also when a later upload of the same pass fails.
    if (ok) m_waitMs = 0;
    else if (code >= 400 && code <= 599) m_waitMs = m_waitMs ? (m_waitMs * 2 < m_maxWaitMs ? m_waitMs * 2 : m_maxWaitMs) : m_firstWaitMs;

    if (m_small || bodyBytes <= m_smallBytes) return false;  // says nothing about large bodies
    if (ok) {
      m_refusals = 0;
      return false;
    }
    if (!bodyRelated(code) || ++m_refusals < kBodyRefusals) return false;
    m_small = true;
    return true;
  }

 private:
  size_t m_fullBytes, m_smallBytes;
  uint32_t m_firstWaitMs, m_maxWaitMs;
  uint32_t m_waitMs = 0;
  uint8_t m_refusals = 0;  // refused large bodies since the last accepted one
  bool m_small = false;
};

// ---- Upload diagnostics ----

// Why uploads failed only reaches the serial console, which nobody reads in the car. On
// 2026-11-20 no upload went through for 46 minutes and the reason was lost. UploadDiag keeps
// what happened since the last accepted upload, and the next upload carries it as a query
// string, which the backend stores with that upload (ingests.diag):
//   f  POSTs that failed since the last accepted upload
//   e  their codes, "code.count" joined by commas, at most kCodes codes, then "x.count" for
//      the rest. net::post() codes: an HTTP status, or -1 no data link, -2 HTTP start
//      refused, -3 request setup refused, -4 body not taken, -5 body not confirmed, -6 send
//      refused, -7 no answer, 700 and up a modem network or TLS error.
//   g  seconds since the last accepted upload, since power-up before the first one
//   d  seconds of that without a data link
//   b  1 while g counts from power-up
//   w  accepted uploads that went without this report (see below). g, f and d then count
//      from the accepted upload before them.
//   a  largest body accepted since power-up, bytes
//   r  smallest body since power-up that failed with a code the body can cause (bodyRelated)
// While uploads go through on time nothing is added. It is added after a failure, after time
// without a data link, after a gap over kQuietGapMs, and to the first upload after power-up,
// so every session tells how long the modem took to get a data link.
//
// The real modem has not been shown to take a URL with a query. So the query must never stop
// uploads: a try that carried it and failed is followed by one without it, and should the
// modem refuse the request setup (-3) with the query, no query is sent until the next
// power-up. A try without the query that is accepted while a report waits leaves the report
// to the next upload, which then counts it in w. The size test counts the same way (onProbe).
class UploadDiag {
 public:
  static constexpr uint8_t kCodes = 4;
  static constexpr uint32_t kQuietGapMs = 180000;  // 3 parked upload periods
  // Room for the longest query (116 characters) with the URL still under 256.
  static constexpr size_t kQueryMax = 120;

  // Every turn of the net task, and again once it has brought the link up, with whether the
  // data link is up. Time without it adds up.
  void onTick(bool linkUp, uint32_t now) {
    if (!m_linkUp) m_downMs += now - m_lastTick;
    m_linkUp = linkUp;
    m_lastTick = now;
  }

  // After every POST of the upload loop, with the query() made for it. An accepted one that
  // carried the report, had nothing to say when it went, or went while the query is off starts
  // the count again. Returns true when this result turned the query off until the next power-up.
  bool onPost(size_t bytes, int code, uint32_t now) {
    bool ok = code >= 200 && code < 300;
    bool carried = m_carrying, withheld = m_withheld;
    m_carrying = m_withheld = false;
    bool turnedOff = carried && code == -3 && !m_off;
    if (turnedOff) m_off = true;
    m_hold = carried && !ok;  // never two tries in a row with the query
    if (ok) {
      if (bytes > m_okMax) m_okMax = bytes;
      // An accepted upload proves the link, and the time up to it was not without one.
      m_linkUp = true;
      m_lastTick = now;
      if (withheld) wentWithout();  // the report waits for the next upload
      else restart(now);
      return turnedOff;
    }
    if (m_fails < 65535) m_fails++;
    count(code);
    badBody(bytes, code);
    return turnedOff;
  }

  // After every POST of the size test ("u" in the console), which carries no report. Its
  // bodies count for a and r. An accepted one is an upload like any other: it went without the
  // report that waits, or, with nothing to say, starts the count again. Its failures are the
  // test's own and are not counted.
  void onProbe(size_t bytes, int code, uint32_t now) {
    if (code >= 200 && code < 300) {
      if (bytes > m_okMax) m_okMax = bytes;
      if (due(now)) wentWithout();
      else restart(now);
    } else {
      badBody(bytes, code);
    }
  }

  // What the next upload carries: the report, or "" when there is nothing to say, when the
  // last try carried it and failed, or when the query is off. Remembers which, for onPost.
  const char* query(char* buf, uint32_t now) {
    buf[0] = 0;
    m_carrying = m_withheld = false;
    if (m_off) return buf;
    report(buf, now);
    if (buf[0] && m_hold) {
      buf[0] = 0;
      m_withheld = true;
    }
    m_carrying = buf[0] != 0;
    return buf;
  }

  // The report itself, starting with '?', or "" when there is nothing to say. buf must hold
  // kQueryMax bytes.
  const char* report(char* buf, uint32_t now) const {
    buf[0] = 0;
    if (!due(now)) return buf;
    uint32_t gapMs = now - m_lastOk;  // m_lastOk is 0 until the first one: time since power-up
    // The longest query is 116 characters. Should it ever not fit, snprintf cuts it and the
    // backend drops what it cannot read.
    size_t n = 0;
    auto room = [&]() { return n < kQueryMax ? kQueryMax - n : (size_t)0; };
    auto step = [&](int w) { n = w > 0 && n + (size_t)w < kQueryMax ? n + (size_t)w : kQueryMax; };
    step(snprintf(buf, kQueryMax, "?f=%u&g=%lu&d=%lu%s", (unsigned)m_fails, (unsigned long)(gapMs / 1000),
                  (unsigned long)(m_downMs / 1000), m_haveOk ? "" : "&b=1"));
    if (m_without && room()) step(snprintf(buf + n, room(), "&w=%u", (unsigned)m_without));
    for (uint8_t i = 0; i < m_nCodes && room(); i++) {
      step(snprintf(buf + n, room(), "%s%d.%u", i ? "," : "&e=", (int)m_codes[i], (unsigned)m_counts[i]));
    }
    if (m_other && room()) step(snprintf(buf + n, room(), "%sx.%u", m_nCodes ? "," : "&e=", (unsigned)m_other));
    if (m_okMax && room()) step(snprintf(buf + n, room(), "&a=%u", (unsigned)m_okMax));
    if (m_badMin && room()) step(snprintf(buf + n, room(), "&r=%u", (unsigned)m_badMin));
    return buf;
  }

  // For the console.
  uint16_t fails() const { return m_fails; }
  uint32_t downMs() const { return m_downMs; }
  bool off() const { return m_off; }

 private:
  // Something to say: anything but uploads going through on time.
  bool due(uint32_t now) const { return !m_haveOk || m_fails || m_downMs >= 1000 || now - m_lastOk > kQuietGapMs; }

  // An accepted upload left nothing waiting: the count starts again from it.
  void restart(uint32_t now) {
    m_fails = 0;
    m_nCodes = 0;
    m_other = 0;
    m_downMs = 0;
    m_without = 0;
    m_lastOk = now;
    m_haveOk = true;
  }

  void wentWithout() {
    if (m_without < 255) m_without++;
  }

  void badBody(size_t bytes, int code) {
    if (bodyRelated(code) && (m_badMin == 0 || bytes < m_badMin)) m_badMin = bytes;
  }

  void count(int code) {
    for (uint8_t i = 0; i < m_nCodes; i++) {
      if (m_codes[i] == code) {
        if (m_counts[i] < 65535) m_counts[i]++;
        return;
      }
    }
    if (m_nCodes < kCodes) {
      m_codes[m_nCodes] = (int16_t)code;
      m_counts[m_nCodes++] = 1;
    } else if (m_other < 65535) {
      m_other++;
    }
  }

  uint16_t m_fails = 0;
  int16_t m_codes[kCodes] = {};
  uint16_t m_counts[kCodes] = {};
  uint8_t m_nCodes = 0;
  uint16_t m_other = 0;
  bool m_linkUp = false;  // down from power-up until the first tick says otherwise
  uint32_t m_lastTick = 0;
  uint32_t m_downMs = 0;
  uint32_t m_lastOk = 0;
  bool m_haveOk = false;
  uint8_t m_without = 0;  // accepted uploads that went without the report that waits
  size_t m_okMax = 0;
  size_t m_badMin = 0;
  bool m_carrying = false;  // the last query() gave a query, so the POST after it carried one
  bool m_withheld = false;  // the last query() held a waiting report back (m_hold)
  bool m_hold = false;      // the last POST carried the query and failed: the next goes without
  bool m_off = false;       // the modem refused the request setup with the query
};

// ---- GNSS ----

// Satellites to store with a valid fix. The SIM7670G sometimes leaves every count field of
// +CGNSSINFO empty on a valid fix: 207 of 27,551 fix records of the first build 2 drives
// were stored with 0 satellites. The last count of this power-up stands in then. A fix before
// the first count of a power-up still gets 0.
constexpr uint8_t fixSats(int counted, uint8_t last) { return counted > 0 ? (counted > 255 ? 255 : (uint8_t)counted) : last; }

// ---- Modem restart ----

constexpr uint32_t kReapplyEveryMs = 60000;

// The modem can restart while the ESP32 keeps running (a voltage dip while cranking is
// enough). It then forgets echo off, the TLS context, SNI and GNSS power. If uploads
// still work with its defaults, nothing else would notice, and GNSS would stay off for
// the whole drive. The sign is the echo: only a modem that lost ATE0 sends a command
// back. The settings are then applied again, at most once per minute, until the modem
// takes the last of them.
class RestartWatch {
 public:
  // A command came back as an echo.
  void onEcho() { m_seen = true; }
  bool seen() const { return m_seen; }

  // True = apply the modem settings again now. Held to once per minute, so a modem that
  // keeps echoing cannot get the setup commands on every turn of the net task.
  bool due(uint32_t now) const { return m_seen && (!m_tried || now - m_lastTry >= kReapplyEveryMs); }

  // The settings were sent again. gnssOk = the modem accepted the GNSS power command, the
  // last one. A modem that is still starting up refuses it and gets another try later.
  // (The echo of ATE0 itself arrives before this call, so it does not set the flag back.)
  void applied(uint32_t now, bool gnssOk) {
    m_tried = true;
    m_lastTry = now;
    if (gnssOk) m_seen = false;
  }

  // The settings are known to be fresh: begin() has just set them.
  void clear() { m_seen = false; }

 private:
  bool m_seen = false;
  bool m_tried = false;
  uint32_t m_lastTry = 0;
};

}  // namespace netpol
