#pragma once
#include <stdint.h>

// Engine gate: decides when the car may be asked anything, and when to stop asking.
//
// The logger must not keep the car awake. While quiet the only request it ever sends is
// 010C (RPM), on the schedule below. Only an RPM reply above zero proves a running
// engine. Voltage never does: GM's charging control lets a running engine sit near 12 V,
// and a charger can hold 13 V and more with the engine off. Voltage only sets how soon
// and how often to probe.
//
// Probe schedule while quiet. A window opens at connect, on going quiet, and when the
// adapter voltage rises 0.4 V above the lowest value seen since the window opened. The
// first probe of a window goes out at once. After that: every 5 s for the first 60 s if
// the voltage is 13.0 V or more, otherwise every 30 s until the window is 10 minutes
// old, then every 5 minutes for an hour, then nothing. A quiet period gets at most 120
// scheduled probes. A reconnect of the adapter link while quiet does not start a new
// period, so a link that drops now and then cannot refill that budget. Its probe goes
// out once the last probe is old enough, at once or later, never closer than that.
//
// Past the 120, only a new voltage rise or a reconnect sends a probe, so a real start is
// still found. Such a probe has no schedule behind it, only one repeat 30 s later in
// case its reply was lost. The probe that uses up the 120 gets that repeat too. The
// first 20 probes past the budget are at least 30 s apart. After that a rise or a
// reconnect is answered at most once per 5 minutes.
//
// This file is plain C++17 with no Arduino headers, so test/host/test_engine_gate.cpp
// runs it against timelines on a PC. Times are millis() values and may wrap around.

namespace gate {

constexpr int      kChargingMv    = 13000;       // at or above this the first minute is probed fast
constexpr int      kRiseMv        = 400;         // rise over the window's lowest reading that opens a new window
constexpr uint32_t kFastEveryMs   = 5000;
constexpr uint32_t kFastForMs     = 60000;
constexpr uint32_t kNormalEveryMs = 30000;
constexpr uint32_t kNormalForMs   = 10 * 60000;
constexpr uint32_t kSlowEveryMs   = 5 * 60000;
constexpr uint32_t kSlowForMs     = 60 * 60000;  // length of the slow phase that follows the 10 minutes
constexpr uint16_t kMaxProbes     = 120;         // scheduled probes per quiet period
constexpr uint16_t kExtraFast     = 20;          // probes past that budget that may come 30 s apart, later ones 5 minutes
constexpr uint32_t kOffGraceMs    = 20000;       // active mode ends after this long without RPM above zero
constexpr uint32_t kEngineHoldMs  = 3000;        // a missed RPM reply keeps the engine-on flag this long
constexpr uint32_t kQuietRecordMs = 30000;       // parked heartbeat
constexpr uint8_t  kSearchAfter   = 3;           // unanswered probes in a row at charging voltage before the one protocol search

// Time between probes for a window of this age. 0 = the schedule has ended.
constexpr uint32_t probeEveryMs(uint32_t ageMs, int mv) {
  if (ageMs < kFastForMs && mv >= kChargingMv) return kFastEveryMs;
  if (ageMs < kNormalForMs) return kNormalEveryMs;
  if (ageMs < kNormalForMs + kSlowForMs) return kSlowEveryMs;
  return 0;
}

enum class Probe : uint8_t {
  NoReply,  // timeout, NO DATA, or anything else that is not an RPM value
  Stopped,  // the ECU answered with RPM 0
  Running,  // RPM above zero
};

class EngineGate {
 public:
  // The adapter link is up. The first connect of a boot, and a reconnect after the link
  // was lost in active mode, start a quiet period: the next tick probes at once. A
  // reconnect while already quiet carries the period on with the probes it has used.
  // Otherwise every drop of the link would hand out a fresh budget and a fresh schedule.
  // It probes at once when the last probe is old enough, otherwise as soon as it is.
  // Dropping that probe instead could leave a start during the link drop unseen for up
  // to 5 minutes.
  void onConnect(uint32_t now) {
    if (!m_connectedOnce || m_active) {
      m_connectedOnce = true;
      enterQuiet(now);
      return;
    }
    m_recordNow = true;
    m_hotMisses = 0;
    if (now - m_lastProbe >= reconnectEveryMs()) m_openNow = true;
    else m_connectProbe = true;
  }

  bool active() const { return m_active; }

  // Quiet mode, once per tick, with the adapter voltage in millivolts.
  // True = send one 010C now and give the answer to onProbe().
  bool wantProbe(uint32_t now, int mv) {
    if (m_active) return false;
    bool spent = m_probes >= kMaxProbes;
    // The probe a reconnect is owed, now that the last probe is old enough.
    if (m_connectProbe && now - m_lastProbe >= reconnectEveryMs()) m_openNow = true;
    bool rise = !m_openNow && mv >= m_lowMv + kRiseMv;
    // With the budget spent, a rise is the only thing that can still cause a probe, so
    // that a real start is never missed. It is held to one per 30 s, and after 20 probes
    // past the budget to one per 5 minutes: a voltage that keeps swinging must not turn
    // into a probe every 30 s for as long as the board has power.
    if (rise && spent && now - m_lastProbe < extraEveryMs()) rise = false;
    if (m_openNow || rise) {
      m_openNow = false;
      m_connectProbe = false;
      m_winStart = now;
      m_lowMv = mv;
      m_lastProbe = now;
      m_inWindow = !spent;  // no schedule behind a probe that is over the budget
      m_repeat = spent;     // only the one repeat below
      if (spent) countExtra();
      else countScheduled();
      return true;
    }
    if (mv < m_lowMv) m_lowMv = mv;
    // The reply to a probe past the budget, or to the one that used it up, can get lost.
    // After a real start the voltage then holds steady, no further rise comes, and the
    // gate would stay quiet for the whole drive. So that probe is repeated once, 30 s later.
    if (m_repeat && now - m_lastProbe >= kNormalEveryMs) {
      m_repeat = false;
      m_connectProbe = false;
      m_lastProbe = now;
      countExtra();
      return true;
    }
    if (!m_inWindow) return false;
    uint32_t every = probeEveryMs(now - m_winStart, mv);
    if (every == 0 || spent) {
      m_inWindow = false;  // also keeps a wrapped millis() from restarting an old window
      return false;
    }
    if (now - m_lastProbe < every) return false;
    m_lastProbe = now;
    m_connectProbe = false;
    countScheduled();
    return true;
  }

  // The answer to the probe that wantProbe() asked for.
  void onProbe(uint32_t now, Probe result, int mv) {
    if (m_active) return;
    if (result != Probe::NoReply) m_answered = true;
    if (result == Probe::Running) {
      m_active = true;
      m_lastRun = now;
      m_hotMisses = 0;
      return;
    }
    // Charging voltage and no answer at all: the adapter may be on the wrong protocol.
    if (result == Probe::NoReply && mv >= kChargingMv) {
      if (m_hotMisses < 255) m_hotMisses++;
    } else {
      m_hotMisses = 0;
    }
  }

  // Quiet mode, after onProbe(). True at most once per boot: let the adapter run its
  // automatic protocol search now. Never once the car has answered in this boot. The
  // stored protocol is then known to be right, and silence means the engine is off. A
  // search could find nothing and would only put seconds of traffic on a sleeping car.
  bool wantSearch() {
    if (m_active || m_searched || m_answered || m_hotMisses < kSearchAfter) return false;
    m_searched = true;
    return true;
  }

  // Active mode, for the record of this poll: does it carry the engine-on flag?
  // rpm is the RPM this poll returned, negative when there was no reply. A reply decides
  // it. A missing reply does not: the flag holds for 3 s after the last RPM above zero,
  // so one lost reply on the newest record does not show a moving car as parked.
  bool engineOn(uint32_t now, int rpm) const {
    if (rpm >= 0) return rpm > 0;
    return m_active && now - m_lastRun <= kEngineHoldMs;
  }

  // Active mode, after every poll. running = this poll returned RPM above zero.
  void onPoll(uint32_t now, bool running) {
    if (!m_active) return;
    if (running) m_lastRun = now;
    else if (now - m_lastRun >= kOffGraceMs) enterQuiet(now);
  }

  // Quiet mode: true when a record is due. One on entering quiet, then one every 30 s.
  bool wantQuietRecord(uint32_t now) {
    if (m_active) return false;
    if (!m_recordNow && now - m_lastRecord < kQuietRecordMs) return false;
    m_recordNow = false;
    m_lastRecord = now;
    return true;
  }

  // For the serial console and the tests.
  uint16_t probes() const { return m_probes; }            // scheduled probes in this quiet period
  uint16_t extraProbes() const { return m_extraProbes; }  // probes after the budget was spent. Stops at 65,535.
  bool searched() const { return m_searched; }

 private:
  void enterQuiet(uint32_t now) {
    m_active = false;
    m_openNow = true;
    m_inWindow = false;
    m_recordNow = true;
    m_repeat = false;
    m_connectProbe = false;
    m_probes = 0;
    m_extraProbes = 0;
    m_hotMisses = 0;
    m_lastProbe = now;
    m_lastRecord = now;
  }

  // Shortest time between two probes past the budget that a rise or a reconnect can cause.
  uint32_t extraEveryMs() const { return m_extraProbes < kExtraFast ? kNormalEveryMs : kSlowEveryMs; }

  // Shortest time from the last probe to the probe of a reconnect while quiet.
  uint32_t reconnectEveryMs() const { return m_probes >= kMaxProbes ? extraEveryMs() : kNormalEveryMs; }

  // The probe that uses up the budget gets the one repeat that probes past it get. With
  // its reply lost, nothing else would ask again: no schedule is left and a steady
  // voltage brings no rise.
  void countScheduled() {
    if (++m_probes == kMaxProbes) m_repeat = true;
  }

  void countExtra() {
    if (m_extraProbes < 0xFFFF) m_extraProbes++;
  }

  bool m_active = false;
  bool m_connectedOnce = false;  // onConnect() has run in this boot
  bool m_openNow = true;     // open a window on the next tick
  bool m_inWindow = false;   // a window's schedule is running
  bool m_recordNow = true;   // a quiet record is due on the next tick
  bool m_repeat = false;     // the last probe was past the budget, or used it up, and has not been repeated yet
  bool m_connectProbe = false;  // a reconnect while quiet came too soon after the last probe. It probes later.
  bool m_searched = false;   // the one protocol search of this boot has been handed out
  bool m_answered = false;   // the car has answered a probe in this boot. Never cleared.
  uint8_t m_hotMisses = 0;
  uint16_t m_probes = 0;
  uint16_t m_extraProbes = 0;
  int m_lowMv = 0;           // lowest voltage since the window opened
  uint32_t m_winStart = 0;
  uint32_t m_lastProbe = 0;
  uint32_t m_lastRun = 0;    // last RPM above zero
  uint32_t m_lastRecord = 0;
};

}  // namespace gate
