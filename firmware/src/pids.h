#pragma once
#include <Arduino.h>
#include "record.h"

namespace pids {

void reset();                     // call after every (re)connect
float adapterVolts();             // ATRV, adapter-local, no CAN traffic. NAN on failure.

// Ask the ECU which PIDs it supports (0100, 0120, ...). True if an ECU answered.
// Runs once RPM has been seen, never while quiet.
bool probe();
// The adapter's automatic protocol search (ATSP0, then 0100, up to 12 s). Runs at most
// once per boot, later calls return false at once. A protocol it finds is saved.
// The engine gate says when to call it. Afterwards the adapter is fixed on one protocol
// again. If it does not confirm that, the link is dropped and the reconnect sets it.
bool searchProtocol();
bool engineRpm(uint16_t& rpm);    // one 010C request, the only thing sent to the car while quiet

// RPM, speed, MAF, throttle, coolant, IAT. RPM is asked first. Without an RPM reply in
// this call and the one before, nothing else is asked. A PID skipped after 3 NO DATA
// answers is asked again within 10 s in the first 2 minutes of polling, within a minute
// after that.
void pollFast(Record& r);
void pollSlow(Record& r);         // fuel level, ECU voltage, odometer. Call it only in a tick that has RPM.
void carrySlow(Record& r);        // copy last slow values into r

// Parse "41PPAABBCC.." from a mode 01 response. Exposed for unit testing.
bool parseMode01(const String& rsp, uint8_t pid, uint8_t* out, int nbytes);

// MPG from MAF (g/s) and speed (km/h). NAN when MAF is ~0.
float instantMpg(float mafGs, float speedKph);
float gallonsFromMaf(float mafGs, float dtSec);

}  // namespace pids
