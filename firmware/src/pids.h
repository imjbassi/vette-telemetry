#pragma once
#include <Arduino.h>
#include "record.h"

namespace pids {

void reset();                     // call after every (re)connect
float adapterVolts();             // ATRV, adapter-local, no CAN traffic. NAN on failure.

// Ask the ECU which PIDs it supports (0100, 0120, ...). True if an ECU answered.
// allowSearch lets it fall back to the adapter's automatic protocol search, which is
// slow, so only pass true when the engine is known to be running.
bool probe(bool allowSearch);
bool engineRpm(uint16_t& rpm);    // one 010C request, used as the quiet-mode engine check

void pollFast(Record& r);         // RPM, speed, coolant, IAT, MAF, throttle
void pollSlow(Record& r);         // fuel level, ECU voltage, odometer
void carrySlow(Record& r);        // copy last slow values into r

// Parse "41PPAABBCC.." from a mode 01 response. Exposed for unit testing.
bool parseMode01(const String& rsp, uint8_t pid, uint8_t* out, int nbytes);

// MPG from MAF (g/s) and speed (km/h). NAN when MAF is ~0.
float instantMpg(float mafGs, float speedKph);
float gallonsFromMaf(float mafGs, float dtSec);

}  // namespace pids
