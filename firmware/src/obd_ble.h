#pragma once
#include <Arduino.h>

// BLE central for the OBDLink CX. Serial-over-GATT: write commands to FFF2, responses
// arrive as notifications on FFF1 and end with the ELM '>' prompt.
namespace obd {

bool begin();                       // init NimBLE stack
bool connect(uint32_t scanSeconds); // scan, connect, subscribe. Prints GATT table.
bool connected();
void disconnect();
void forgetBonds();                 // delete stored pairings (serial command "unpair")

// Send one command (CR appended). Returns cleaned response text without the prompt,
// lines joined with '\n'. Empty string on timeout.
String cmd(const char* c, uint32_t timeoutMs);

// ELM protocol number in use ('1'..'9', 'A'..'C'). Starts at OBD_PROTOCOL, and a
// successful protocol search stores its result so later boots skip the search.
char protocol();
void setProtocol(char p);

// Adapter setup: ATZ, echo/linefeed/spaces/headers off, adaptive timing, fixed protocol.
// Sends nothing to the car. True if the adapter answered.
bool initElm();

}  // namespace obd
