#pragma once
#include "record.h"

// Desk build only (env atoms3-bench, BENCH=1): a scripted adapter (bench_obd.cpp) and a
// scripted network (bench_net.cpp) around the unchanged gate, PID, queue and upload code.
namespace bench {

// main.cpp reports every record it hands to storage. The scripted network then checks
// that each one arrives exactly once and in order.
void onStored(const Record& r);

}  // namespace bench
