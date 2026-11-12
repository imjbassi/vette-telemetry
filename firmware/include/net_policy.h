#pragma once
#include <stddef.h>
#include <stdint.h>

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
