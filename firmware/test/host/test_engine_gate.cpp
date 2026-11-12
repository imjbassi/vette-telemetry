// The engine gate (include/engine_gate.h) against timelines. Sim::run() makes the same
// calls in the same order as tick() in src/main.cpp, with a scripted car in place of the
// adapter: 2 s ticks while quiet, 1 s ticks while active.
#include <functional>
#include <vector>
#include "check.h"
#include "engine_gate.h"

struct Car {
  std::function<int(double)> mv;   // adapter voltage in mV, t seconds after connect
  std::function<int(double)> rpm;  // RPM the ECU reports, -1 = no reply
};

struct Sim {
  gate::EngineGate g;
  uint32_t t0, now;
  std::vector<double> probes;        // when a 010C probe went out while quiet
  std::vector<double> quietRecords;  // when a quiet record was stored
  std::vector<double> wentActive, wentQuiet;
  std::vector<double> engineOn;      // when an active record carried the engine-on flag
  int activeRecords = 0;
  int searches = 0;

  explicit Sim(uint32_t startMs = 5000) : t0(startMs), now(startMs) { g.onConnect(now); }

  double t() const { return (uint32_t)(now - t0) / 1000.0; }

  // The Bluetooth link drops and is back after downS seconds, the way tryConnect() reports it.
  void reconnect(double downS = 8) {
    now += (uint32_t)(downS * 1000);
    g.onConnect(now);
  }

  void run(double untilS, const Car& car) {
    while (t() < untilS) {
      double at = t();
      int mv = car.mv(at);
      if (!g.active() && g.wantProbe(now, mv)) {
        probes.push_back(at);
        int rpm = car.rpm(at);
        gate::Probe res = rpm < 0 ? gate::Probe::NoReply : rpm > 0 ? gate::Probe::Running : gate::Probe::Stopped;
        g.onProbe(now, res, mv);
        if (g.active()) wentActive.push_back(at);
        else if (g.wantSearch()) searches++;
      }
      if (g.active()) {
        int rpm = car.rpm(at);
        if (g.engineOn(now, rpm)) engineOn.push_back(at);
        g.onPoll(now, rpm > 0);
        activeRecords++;
        if (!g.active()) wentQuiet.push_back(at);
      } else if (g.wantQuietRecord(now)) {
        quietRecords.push_back(at);
      }
      now += g.active() ? 1000 : 2000;
    }
  }

  int probesBetween(double from, double to) const {
    int n = 0;
    for (double p : probes) n += p >= from && p < to;
    return n;
  }
};

// The schedule itself.
static_assert(gate::probeEveryMs(0, 13000) == 5000);
static_assert(gate::probeEveryMs(59999, 13000) == 5000);
static_assert(gate::probeEveryMs(60000, 13000) == 30000);
static_assert(gate::probeEveryMs(0, 12999) == 30000);
static_assert(gate::probeEveryMs(599999, 12000) == 30000);
static_assert(gate::probeEveryMs(600000, 14000) == 300000);
static_assert(gate::probeEveryMs(4199999, 12000) == 300000);
static_assert(gate::probeEveryMs(4200000, 12000) == 0);
static_assert(gate::kMaxProbes == 120);

// A two minute drive, then parked for three hours. The voltage sinks from 12.9 to 12.4 V.
static void parkedThreeHoursAfterADrive() {
  Car car;
  car.rpm = [](double t) { return t < 120 ? 1800 : -1; };
  car.mv = [](double t) -> int {
    if (t < 120) return 14200;
    int v = 12900 - (int)((t - 120) * 0.8);
    return v < 12400 ? 12400 : v;
  };
  Sim s;
  double end = 120 + 3 * 3600;
  s.run(end, car);

  CHECK_EQ(s.wentActive.size(), 1);  // found running by the probe at connect
  CHECK(s.wentActive[0] == 0);
  CHECK_EQ(s.wentQuiet.size(), 1);   // last RPM at 119 s, quiet 20 s later
  double q = s.wentQuiet[0];
  CHECK(q >= 139 && q <= 141);

  // One probe at connect. In the quiet period: one at once, then every 30 s until the
  // window is 10 minutes old (20 probes), then every 5 minutes for an hour (12 probes).
  CHECK_EQ(s.probes.size(), 1 + 20 + 12);
  CHECK_EQ(s.g.probes(), 32);
  CHECK_EQ(s.g.extraProbes(), 0);
  double w = s.probes[1];  // the window opened on the first quiet tick
  CHECK(w - q <= 2);
  for (int i = 2; i <= 20; i++) CHECK(s.probes[i] - s.probes[i - 1] == 30);
  for (int i = 21; i <= 32; i++) CHECK(s.probes[i] - s.probes[i - 1] == 300);
  // Nothing after the schedule ends, for almost two more hours.
  CHECK(s.probes.back() < w + 4200);
  CHECK_EQ(s.probesBetween(w + 4200, end), 0);
  CHECK(end - (w + 4200) > 6000);
  CHECK_EQ(s.searches, 0);

  // Parked heartbeat: one record on entering quiet, then one every 30 s to the end.
  CHECK(!s.quietRecords.empty() && s.quietRecords[0] - q <= 2);
  for (size_t i = 1; i < s.quietRecords.size(); i++) CHECK(s.quietRecords[i] - s.quietRecords[i - 1] == 30);
  CHECK(s.quietRecords.size() >= 355 && s.quietRecords.size() <= 362);
  CHECK(end - s.quietRecords.back() <= 32);
}

// Engine off from 100 s to 148 s (a 48 s stop), running again, off from 300 s to 400 s.
// The voltage is flat, so it gives no hint and only the schedule can find the restart.
static void restartsWithFlatVoltage(int mvFlat, double firstMaxDelayS, int wantSearches, uint32_t startMs) {
  Car car;
  car.rpm = [](double t) { return (t >= 100 && t < 148) || (t >= 300 && t < 400) ? -1 : 1500; };
  car.mv = [mvFlat](double) { return mvFlat; };
  Sim s(startMs);
  s.run(500, car);

  CHECK_EQ(s.wentQuiet.size(), 2);
  CHECK_EQ(s.wentActive.size(), 3);
  if (s.wentQuiet.size() != 2 || s.wentActive.size() != 3) return;
  CHECK(s.wentQuiet[0] >= 119 && s.wentQuiet[0] <= 121);
  // Detected within the scheduled interval (plus one 2 s quiet tick).
  CHECK(s.wentActive[1] >= 148 && s.wentActive[1] - 148 <= firstMaxDelayS);
  // The second stop outlasts the fast first minute, so 30 s applies either way.
  CHECK(s.wentActive[2] >= 400 && s.wentActive[2] - 400 <= 32);
  // The car answered in this boot, so the stored protocol is right. Silence after that
  // means the engine is off, and no search runs however often the car stops.
  CHECK_EQ(s.searches, wantSearches);
  CHECK(s.g.active());
}

// A normal drive, then the engine is off and the battery rests at 13.2 V for an hour.
// Three unanswered probes at charging voltage follow within seconds. The protocol
// answered a minute earlier, so the search must not run.
static void noSearchAfterAnAnsweredDrive() {
  Car car;
  car.rpm = [](double t) { return t < 600 ? 1800 : -1; };
  car.mv = [](double t) { return t < 600 ? 14200 : 13200; };
  Sim s;
  s.run(4200, car);
  CHECK_EQ(s.wentQuiet.size(), 1);
  CHECK(s.probesBetween(620, 660) >= 3);
  CHECK_EQ(s.searches, 0);
  CHECK(!s.g.searched());

  // Ignition on with the engine off: the ECU answers RPM 0, then goes to sleep while a
  // charger holds 13.4 V. An RPM 0 reply is an answer too.
  Car keyOn;
  keyOn.rpm = [](double t) { return t < 20 ? 0 : -1; };
  keyOn.mv = [](double) { return 13400; };
  Sim k;
  k.run(3600, keyOn);
  CHECK(k.wentActive.empty());
  CHECK_EQ(k.searches, 0);
}

// Nothing for two hours, then a start that lifts the voltage by 1.2 V.
static void startTwoHoursIntoQuiet() {
  Car car;
  car.rpm = [](double t) { return t < 7200 ? -1 : 900; };
  car.mv = [](double t) { return t < 7200 ? 12400 : 13600; };
  Sim s;
  s.run(7300, car);

  CHECK_EQ(s.probesBetween(0, 4200), 32);     // the window from connect ran out
  CHECK_EQ(s.probesBetween(4200, 7200), 0);
  CHECK_EQ(s.wentActive.size(), 1);
  if (s.wentActive.size() == 1) CHECK(s.wentActive[0] >= 7200 && s.wentActive[0] <= 7202);  // probed at once
  CHECK_EQ(s.probes.size(), 33);
}

// A rise of exactly 0.4 V over the lowest reading opens a window, less does not.
static void riseThreshold() {
  Car car;
  car.rpm = [](double) { return -1; };
  car.mv = [](double t) { return t < 5000 ? 12400 : t < 5100 ? 12799 : 12800; };
  Sim s;
  s.run(5200, car);
  CHECK_EQ(s.probesBetween(4200, 5100), 0);
  CHECK_EQ(s.probesBetween(5100, 5102), 1);
  CHECK_EQ(s.probesBetween(5102, 5200), 3);  // the new window runs its 30 s schedule

  // The reference is the lowest reading, so a dip and a recovery count as a rise too.
  Car dip;
  dip.rpm = [](double) { return -1; };
  dip.mv = [](double t) { return t >= 5000 && t < 5100 ? 12000 : 12400; };
  Sim d;
  d.run(5110, dip);
  CHECK_EQ(d.probesBetween(4200, 5100), 0);
  CHECK_EQ(d.probesBetween(5100, 5102), 1);
}

// A battery tender holds 13.4 V for six hours and the engine never runs.
static void batteryTenderHoldingVoltage() {
  Car car;
  car.rpm = [](double) { return -1; };
  car.mv = [](double) { return 13400; };
  Sim s;
  double end = 6 * 3600;
  s.run(end, car);

  CHECK(s.wentActive.empty());
  CHECK(!s.g.active());
  CHECK_EQ(s.activeRecords, 0);
  // Fast probes for the first minute (5 s rounds up to 6 s on a 2 s tick: 10 probes),
  // every 30 s until minute 10 (18), every 5 minutes for an hour (12), then silence.
  CHECK_EQ(s.probes.size(), 40);
  CHECK_EQ(s.g.probes(), 40);
  CHECK(s.probes.back() < 4200);
  CHECK_EQ(s.probesBetween(4200, end), 0);
  // Charging voltage with no answer: the one protocol search of the boot is spent here.
  CHECK_EQ(s.searches, 1);
}

// A charger that steps between 13.2 and 13.7 V every 20 minutes for a day. Each step up
// opens a window. The scheduled probes stop at the cap. After that a step up gets one
// probe, one repeat 30 s later and no schedule, so a real start is still found.
static void cyclingChargerHitsTheCap() {
  Car car;
  car.rpm = [](double t) { return t < 86400 ? -1 : 800; };
  car.mv = [](double t) { return t >= 86400 ? 14300 : ((int)(t / 1200) % 2 ? 13700 : 13200); };
  Sim s;
  s.run(86400, car);

  CHECK(s.wentActive.empty());
  CHECK_EQ(s.g.probes(), gate::kMaxProbes);
  CHECK(s.g.extraProbes() > 0);
  CHECK(s.g.extraProbes() <= 72);  // 36 steps up in 24 h, at most one probe and one repeat each
  CHECK_EQ(s.probes.size(), (size_t)(s.g.probes() + s.g.extraProbes()));
  CHECK_EQ(s.searches, 1);

  s.run(86460, car);
  CHECK_EQ(s.wentActive.size(), 1);
  if (s.wentActive.size() == 1) CHECK(s.wentActive[0] <= 86402);
}

// The same day on the charger, then a real start. The reply to the one probe that the
// voltage rise buys is lost (the ECU answers 3 s later). The voltage then holds steady, so
// no further rise comes. The repeat 30 s later must find the engine.
static void lostReplyAfterTheCap() {
  Car car;
  car.rpm = [](double t) { return t < 86403 ? -1 : 800; };
  car.mv = [](double t) { return t >= 86400 ? 14300 : ((int)(t / 1200) % 2 ? 13700 : 13200); };
  Sim s;
  s.run(86400, car);
  CHECK(s.wentActive.empty());
  CHECK_EQ(s.g.probes(), gate::kMaxProbes);
  s.run(86400 + 3600, car);
  CHECK_EQ(s.probesBetween(86400, 86402), 1);  // the rise probe, unanswered
  CHECK_EQ(s.wentActive.size(), 1);
  if (s.wentActive.size() == 1) CHECK(s.wentActive[0] <= 86400 + 32);
}

// A jittery voltage uses up 118 or 119 of the 120 scheduled probes. Then the engine
// starts at a steady 14.3 V and the reply to the probe that the rise sends is lost (the
// ECU answers 3 s later). With 119 used, that probe is number 120: no schedule is left
// and a steady voltage brings no further rise. The old code then stayed quiet for the
// whole drive. The probe that uses up the budget is repeated once, 30 s later.
static void lostReplyOnTheLastScheduledProbe() {
  for (int used : {118, 119}) {
    double start = 1e9;
    Car car;
    car.rpm = [&start](double t) { return t < start + 3 ? -1 : 800; };
    car.mv = [&start](double t) { return t >= start ? 14300 : ((int)(t / 4) % 2 ? 12900 : 12400); };
    Sim s;
    while (s.g.probes() < used) s.run(s.t() + 1, car);  // one tick per call
    CHECK_EQ(s.g.probes(), used);
    start = s.t();
    s.run(start + 3600, car);
    CHECK_EQ(s.probesBetween(start, start + 2), 1);  // the rise probe, unanswered
    CHECK_EQ(s.wentActive.size(), 1);
    if (s.wentActive.size() == 1) CHECK(s.wentActive[0] <= start + (used == 119 ? 32 : 8));
    CHECK_EQ(s.g.probes(), gate::kMaxProbes);
    CHECK_EQ(s.g.extraProbes(), used == 119 ? 1 : 0);  // the one repeat
  }
}

// With the budget spent, a jittery voltage cannot buy more than one probe per 30 s, and
// after 20 such probes only one and its repeat per 5 minutes, for as long as it lasts.
static void spentBudgetIsRateLimited() {
  Car car;
  car.rpm = [](double) { return -1; };
  // 0.5 V steps every 4 s. Every other quiet tick sees a rise.
  car.mv = [](double t) { return (int)(t / 4) % 2 ? 12900 : 12400; };
  Sim s;
  s.run(4 * 3600, car);
  CHECK_EQ(s.g.probes(), gate::kMaxProbes);
  double capAt = s.probes[gate::kMaxProbes - 1];
  int after = s.probesBetween(capAt + 1, 4 * 3600);
  CHECK(after > 0);
  CHECK(after <= (int)((4 * 3600 - capAt) / 30) + 1);
  CHECK(s.wentActive.empty());
  // Never two probes closer than 30 s once the budget is spent.
  for (size_t i = gate::kMaxProbes; i < s.probes.size(); i++) CHECK(s.probes[i] - s.probes[i - 1] >= 30);
  // The first 20 come 30 s apart, so a start soon after the cap is found fast.
  CHECK(s.probesBetween(capAt + 1, capAt + 700) >= 20);

  // Day 2 of the same jitter: a probe and its repeat per 5 minutes and 30 s, not 2,880 a day.
  s.run(2 * 86400, car);
  int day2 = s.probesBetween(86400, 2 * 86400);
  CHECK(day2 > 0);
  CHECK(day2 <= 2 * (86400 / 330 + 1));
  CHECK(s.wentActive.empty());

  // The count of probes past the cap stops at 65,535 instead of starting over at 0,
  // which would also bring the 30 s rate back. 140 more days of the same jitter, fed to
  // the gate directly: the Sim's clock ends after 49 days, millis() just wraps.
  const uint32_t ticksPerDay = 43200;  // 2 s quiet ticks
  int lastDay = 0;
  for (uint32_t i = 0; i < 140 * ticksPerDay; i++) {
    int mv = (i / 2) % 2 ? 12900 : 12400;
    if (s.g.wantProbe(s.now, mv)) {
      s.g.onProbe(s.now, gate::Probe::NoReply, mv);
      lastDay += i >= 139 * ticksPerDay;
    }
    s.now += 2000;
  }
  CHECK_EQ(s.g.extraProbes(), 65535);
  CHECK(lastDay > 0);
  CHECK(lastDay <= 2 * (86400 / 330 + 1));
  CHECK(!s.g.active());
}

// The Bluetooth link drops once an hour for a week while the car is parked at 12.4 V. A
// reconnect while quiet carries the quiet period on. It must not hand out a fresh budget
// of 120 probes and a fresh 70 minute schedule each time.
static void reconnectsDoNotRefillTheBudget() {
  Car car;
  car.rpm = [](double) { return -1; };
  car.mv = [](double) { return 12400; };
  Sim s;
  int reconnects = 0;
  for (int h = 1; h <= 7 * 24; h++) {
    s.run(h * 3600.0, car);
    CHECK(s.g.probes() <= gate::kMaxProbes);
    if (h == 2) CHECK(s.g.probes() > 32);  // the second window counts on from the first
    s.reconnect();
    reconnects++;
  }
  CHECK_EQ(s.g.probes(), gate::kMaxProbes);
  // 120 scheduled probes in total. Past them a reconnect gets one probe and one repeat.
  CHECK(s.probes.size() <= (size_t)(gate::kMaxProbes + 2 * reconnects));
  CHECK(s.probesBetween(6 * 86400.0, 7 * 86400.0) <= 2 * 24 + 2);
  CHECK(s.wentActive.empty());
  CHECK_EQ(s.searches, 0);  // 12.4 V is not charging voltage

  // Every reconnect stores a quiet record at once, so the dashboard sees the link is back.
  Sim r;
  r.run(100, car);
  size_t before = r.quietRecords.size();
  r.reconnect();
  double at = r.t();
  r.run(at + 2, car);
  CHECK_EQ(r.quietRecords.size(), before + 1);
  if (r.quietRecords.size() == before + 1) CHECK(r.quietRecords.back() == at);
}

// A reconnect must still find a running engine at once, in every state it can meet.
static void reconnectFindsARunningEngine() {
  // The link drops while driving. That starts a new quiet period with a probe at once.
  Car driving;
  driving.rpm = [](double) { return 1500; };
  driving.mv = [](double) { return 14200; };
  Sim a;
  a.run(100, driving);
  a.reconnect();
  double back = a.t();
  CHECK(!a.g.active());
  CHECK_EQ(a.g.probes(), 0);
  a.run(back + 10, driving);
  CHECK_EQ(a.wentActive.size(), 2);
  if (a.wentActive.size() == 2) CHECK(a.wentActive[1] == back);

  // Parked for two hours, the schedule has ended. The link drops, the engine is started
  // meanwhile, the link comes back.
  Car late;
  late.rpm = [](double t) { return t < 7200 ? -1 : 900; };
  late.mv = [](double t) { return t < 7200 ? 12400 : 14200; };
  Sim b;
  b.run(7200, late);
  CHECK(b.wentActive.empty());
  b.reconnect();
  back = b.t();
  b.run(back + 10, late);
  CHECK_EQ(b.wentActive.size(), 1);
  if (b.wentActive.size() == 1) CHECK(b.wentActive[0] == back);

  // The same 10 s after a probe, where a reconnect by itself does not probe again. The
  // voltage rise does.
  Car soon;
  soon.rpm = [](double t) { return t < 12 ? -1 : 900; };
  soon.mv = [](double t) { return t < 12 ? 12400 : 14200; };
  Sim c;
  c.run(10, soon);
  c.reconnect();
  back = c.t();
  c.run(back + 10, soon);
  CHECK_EQ(c.wentActive.size(), 1);
  if (c.wentActive.size() == 1) CHECK(c.wentActive[0] == back);
}

// Parked at 12.4 V for 20 minutes, so the window probes once per 5 minutes. The engine
// starts 4 s after a probe and charging control holds 12.7 V, a rise of only 0.3 V. The
// link drops at the crank and is back 16 s after that probe, too soon for a probe of its
// own. The old code dropped that probe and found the engine with the next slow probe,
// 296 s after the start. The reconnect's probe now goes out once 30 s have passed.
static void reconnectSoonAfterAProbeIsNotLost() {
  double start = 1e9;
  Car car;
  car.rpm = [&start](double t) { return t < start ? -1 : 800; };
  car.mv = [&start](double t) { return t < start ? 12400 : 12700; };
  Sim s;
  s.run(1200, car);
  size_t n = s.probes.size();
  while (s.probes.size() == n) s.run(s.t() + 1, car);
  double p = s.probes.back();
  CHECK(p - s.probes[n - 1] == 300);  // a slow-phase probe
  start = p + 4;
  s.run(start, car);
  s.reconnect(12);
  CHECK(s.t() == p + 16);
  s.run(p + 400, car);
  CHECK_EQ(s.probesBetween(p + 1, p + 30), 0);  // never closer than 30 s to the last probe
  CHECK_EQ(s.wentActive.size(), 1);
  if (s.wentActive.size() == 1) CHECK(s.wentActive[0] == p + 30);

  // A link that keeps dropping, every 6 s for 10 minutes, with the engine off. One owed
  // probe at a time, never two closer than 30 s.
  Car off;
  off.rpm = [](double) { return -1; };
  off.mv = [](double) { return 12400; };
  Sim f;
  f.run(1200, off);
  size_t before = f.probes.size();
  double from = f.t();
  for (int i = 0; i < 100; i++) {
    f.reconnect(4);
    f.run(f.t() + 1, off);
  }
  CHECK(f.probes.size() > before);
  for (size_t i = before; i < f.probes.size(); i++) CHECK(f.probes[i] - f.probes[i - 1] >= 30);
  CHECK(f.probesBetween(from, f.t()) <= (int)((f.t() - from) / 30) + 1);
  CHECK(f.g.probes() <= gate::kMaxProbes);
}

// While driving, RPM replies go missing for a while. The voltage is 12.6 V, which says
// nothing: a running engine can sit there.
static void missingRpmReplies() {
  Car shortGap;
  shortGap.rpm = [](double t) { return t >= 60 && t < 75 ? -1 : 2000; };
  shortGap.mv = [](double) { return 12600; };
  Sim a;
  a.run(200, shortGap);
  CHECK(a.wentQuiet.empty());  // 15 s without RPM: still active
  CHECK(a.g.active());
  CHECK_EQ(a.activeRecords, 200);

  Car longGap;
  longGap.rpm = [](double t) { return t >= 60 && t < 85 ? -1 : 2000; };
  longGap.mv = [](double) { return 12600; };
  Sim b;
  b.run(200, longGap);
  CHECK_EQ(b.wentQuiet.size(), 1);  // 25 s without RPM: quiet after 20
  if (b.wentQuiet.size() == 1) CHECK(b.wentQuiet[0] >= 79 && b.wentQuiet[0] <= 81);
  CHECK_EQ(b.wentActive.size(), 2);  // and found again by the schedule
  if (b.wentActive.size() == 2) CHECK(b.wentActive[1] - 85 <= 32);
}

// The engine-on flag of a record. The backend shows the car as parked when the newest
// record lacks it, so one lost RPM reply must not clear it. A real stop must, within 3 s.
static void engineFlagBridgesAMissedReply() {
  // A gate that has never seen RPM gives no flag, with or without a reply.
  gate::EngineGate fresh;
  CHECK(!fresh.engineOn(1000, -1));
  CHECK(!fresh.engineOn(1000, 0));

  // One reply is lost at 60 s, two more at 100 and 101 s. Every record keeps the flag.
  Car car;
  car.rpm = [](double t) { return t == 60 || t == 100 || t == 101 ? -1 : 2000; };
  car.mv = [](double) { return 12600; };
  Sim a;
  a.run(200, car);
  CHECK_EQ(a.activeRecords, 200);
  CHECK_EQ(a.engineOn.size(), 200);

  // The engine stops at 60 s and the ECU goes silent. Last RPM at 59 s: the flag holds
  // through 62 s and is off from 63 s on, long before the gate goes quiet at 79 s.
  Car stop;
  stop.rpm = [](double t) { return t < 60 ? 2000 : -1; };
  stop.mv = [](double) { return 12600; };
  Sim b;
  b.run(200, stop);
  CHECK_EQ(b.wentQuiet.size(), 1);
  CHECK(b.activeRecords >= 79);
  CHECK_EQ(b.engineOn.size(), 63);
  if (!b.engineOn.empty()) CHECK(b.engineOn.back() == 62);
  CHECK(!b.g.engineOn(b.now, -1));  // and never while quiet

  // The engine stops and the ECU keeps answering RPM 0. That is an answer: off at once.
  Car zero;
  zero.rpm = [](double t) { return t < 60 ? 2000 : 0; };
  zero.mv = [](double) { return 12600; };
  Sim c;
  c.run(200, zero);
  CHECK_EQ(c.engineOn.size(), 60);
  if (!c.engineOn.empty()) CHECK(c.engineOn.back() == 59);
}

// Ignition on, engine off: the ECU answers RPM 0. That is an answer, not a running engine.
static void rpmZeroIsNotRunning() {
  Car car;
  car.rpm = [](double t) { return t < 60 ? 2000 : 0; };
  car.mv = [](double) { return 13500; };
  Sim s;
  s.run(3600, car);
  CHECK_EQ(s.wentQuiet.size(), 1);
  CHECK_EQ(s.wentActive.size(), 1);
  CHECK(!s.g.active());
  CHECK_EQ(s.searches, 0);  // the ECU answers, so the protocol is fine
}

// Connect with the engine off: the first quiet record comes at once.
static void quietRecordAtConnect() {
  Car car;
  car.rpm = [](double) { return -1; };
  car.mv = [](double) { return 12400; };
  Sim s;
  s.run(100, car);
  CHECK_EQ(s.quietRecords.size(), 4);
  if (s.quietRecords.size() == 4) {
    CHECK(s.quietRecords[0] == 0);
    CHECK(s.quietRecords[1] == 30);
    CHECK(s.quietRecords[3] == 90);
  }
  CHECK_EQ(s.activeRecords, 0);
}

int main() {
  parkedThreeHoursAfterADrive();
  restartsWithFlatVoltage(12400, 30 + 2, 0, 5000);
  restartsWithFlatVoltage(13500, 5 + 2, 0, 5000);
  // The same two with millis() wrapping around in the middle of the run.
  restartsWithFlatVoltage(12400, 30 + 2, 0, 0xFFFFFFFFu - 130000);
  restartsWithFlatVoltage(13500, 5 + 2, 0, 0xFFFFFFFFu - 130000);
  noSearchAfterAnAnsweredDrive();
  startTwoHoursIntoQuiet();
  riseThreshold();
  batteryTenderHoldingVoltage();
  cyclingChargerHitsTheCap();
  lostReplyAfterTheCap();
  lostReplyOnTheLastScheduledProbe();
  spentBudgetIsRateLimited();
  reconnectsDoNotRefillTheBudget();
  reconnectFindsARunningEngine();
  reconnectSoonAfterAProbeIsNotLost();
  missingRpmReplies();
  engineFlagBridgesAMissedReply();
  rpmZeroIsNotRunning();
  quietRecordAtConnect();
  return finish("test_engine_gate");
}
