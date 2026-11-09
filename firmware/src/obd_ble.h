#pragma once
#include <Arduino.h>

// BLE central for the OBDLink CX. Serial-over-GATT: write commands to FFF2, responses
// arrive as notifications on FFF1 and end with the ELM '>' prompt.
namespace obd {

bool begin();                       // init NimBLE stack
bool connect(uint32_t scanSeconds); // scan, connect, subscribe. Prints GATT table.
bool connected();
void disconnect();

// Send one command (CR appended). Returns cleaned response text without the prompt,
// lines joined with '\n'. Empty string on timeout.
String cmd(const char* c, uint32_t timeoutMs);

// Runs ATZ / ATE0 / ATL0 / ATS0 / ATH0 / ATSP0 / ATAT1 and a 0100 probe.
bool initElm();

}  // namespace obd
