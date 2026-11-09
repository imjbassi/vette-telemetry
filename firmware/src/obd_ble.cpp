#include "obd_ble.h"
#include <NimBLEDevice.h>
#include "config.h"

namespace obd {

static NimBLEClient* s_client = nullptr;
static NimBLERemoteCharacteristic* s_rx = nullptr;  // notify
static NimBLERemoteCharacteristic* s_tx = nullptr;  // write
static volatile bool s_connected = false;

static portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;
static char s_buf[1024];
static volatile size_t s_len = 0;
static SemaphoreHandle_t s_prompt = nullptr;

static void onNotify(NimBLERemoteCharacteristic*, uint8_t* data, size_t len, bool) {
  bool sawPrompt = false;
  portENTER_CRITICAL(&s_mux);
  for (size_t i = 0; i < len; i++) {
    if (s_len < sizeof(s_buf) - 1) s_buf[s_len++] = (char)data[i];
    if (data[i] == '>') sawPrompt = true;
  }
  portEXIT_CRITICAL(&s_mux);
  if (sawPrompt) xSemaphoreGive(s_prompt);
}

class ClientCb : public NimBLEClientCallbacks {
  void onConnect(NimBLEClient*) override { s_connected = true; }
  void onDisconnect(NimBLEClient*) override {
    s_connected = false;
    Serial.println("[ble] disconnected");
  }
};
static ClientCb s_cb;

bool begin() {
  s_prompt = xSemaphoreCreateBinary();
  NimBLEDevice::init("");
  NimBLEDevice::setPower(ESP_PWR_LVL_P9);
  // CX pairs on first subscribe/write. Just Works, bonded, secure connections.
  NimBLEDevice::setSecurityAuth(true, false, true);
  NimBLEDevice::setSecurityIOCap(BLE_HS_IO_NO_INPUT_OUTPUT);
  return true;
}

bool connected() { return s_connected && s_client && s_client->isConnected(); }

void disconnect() {
  if (s_client && s_client->isConnected()) s_client->disconnect();
  s_connected = false;
}

static void dumpGatt(NimBLEClient* c) {
  Serial.println("[ble] GATT table:");
  for (auto* svc : *c->getServices(true)) {
    Serial.printf("  svc %s\n", svc->getUUID().toString().c_str());
    for (auto* ch : *svc->getCharacteristics(true)) {
      Serial.printf("    chr %s%s%s%s%s\n", ch->getUUID().toString().c_str(),
                    ch->canRead() ? " R" : "", ch->canWrite() ? " W" : "",
                    ch->canWriteNoResponse() ? " WnR" : "", ch->canNotify() ? " N" : "");
    }
  }
}

// Prefer documented FFF0/FFF1/FFF2. Fall back to the first notify + write pair found.
static bool pickChars(NimBLEClient* c) {
  s_rx = s_tx = nullptr;
  if (auto* svc = c->getService(OBD_SERVICE_UUID)) {
    s_rx = svc->getCharacteristic(OBD_NOTIFY_UUID);
    s_tx = svc->getCharacteristic(OBD_WRITE_UUID);
  }
  if (s_rx && s_tx) return true;
  for (auto* svc : *c->getServices(false)) {
    for (auto* ch : *svc->getCharacteristics(false)) {
      if (!s_rx && ch->canNotify()) s_rx = ch;
      if (!s_tx && (ch->canWrite() || ch->canWriteNoResponse())) s_tx = ch;
    }
    if (s_rx && s_tx) {
      Serial.printf("[ble] fallback chars in svc %s\n", svc->getUUID().toString().c_str());
      return true;
    }
    s_rx = s_tx = nullptr;
  }
  return false;
}

bool connect(uint32_t scanSeconds) {
  NimBLEScan* scan = NimBLEDevice::getScan();
  scan->setActiveScan(true);
  scan->setInterval(45);
  scan->setWindow(30);
  Serial.printf("[ble] scanning %us for \"%s*\"\n", scanSeconds, OBD_NAME_PREFIX);
  NimBLEScanResults res = scan->start(scanSeconds, false);

  NimBLEAdvertisedDevice* target = nullptr;
  for (auto it = res.begin(); it != res.end(); ++it) {
    std::string name = (*it)->getName();
    if (name.empty()) continue;
    Serial.printf("  seen %s \"%s\" rssi %d\n", (*it)->getAddress().toString().c_str(), name.c_str(), (*it)->getRSSI());
    if (!target && name.rfind(OBD_NAME_PREFIX, 0) == 0) target = *it;
  }
  if (!target) {
    Serial.println("[ble] OBDLink not found");
    scan->clearResults();
    return false;
  }

  if (!s_client) {
    s_client = NimBLEDevice::createClient();
    s_client->setClientCallbacks(&s_cb, false);
    s_client->setConnectTimeout(10);
    s_client->setConnectionParams(12, 24, 0, 400);  // 15-30 ms interval
  }
  Serial.printf("[ble] connecting %s\n", target->getAddress().toString().c_str());
  bool ok = s_client->connect(target, true);
  scan->clearResults();
  if (!ok) { Serial.println("[ble] connect failed"); return false; }
  s_connected = true;
  Serial.printf("[ble] connected, MTU %u\n", s_client->getMTU());

  dumpGatt(s_client);
  if (!pickChars(s_client)) { Serial.println("[ble] no usable chars"); disconnect(); return false; }
  Serial.printf("[ble] rx %s  tx %s\n", s_rx->getUUID().toString().c_str(), s_tx->getUUID().toString().c_str());
  if (!s_rx->subscribe(true, onNotify)) {
    Serial.println("[ble] subscribe failed (pairing rejected? press the CX button and retry)");
    disconnect();
    return false;
  }
  return true;
}

static String clean(const char* raw, size_t n) {
  String out;
  out.reserve(n);
  String line;
  auto flush = [&]() {
    line.trim();
    if (line.length() && line != "SEARCHING...") {
      if (out.length()) out += '\n';
      out += line;
    }
    line = "";
  };
  for (size_t i = 0; i < n; i++) {
    char ch = raw[i];
    if (ch == '>') break;
    if (ch == '\r' || ch == '\n') flush();
    else if (ch != 0) line += ch;
  }
  flush();
  return out;
}

String cmd(const char* c, uint32_t timeoutMs) {
  if (!connected()) return String();
  portENTER_CRITICAL(&s_mux);
  s_len = 0;
  portEXIT_CRITICAL(&s_mux);
  xSemaphoreTake(s_prompt, 0);  // clear stale signal

  String line = String(c) + "\r";
  bool noRsp = s_tx->canWriteNoResponse();
  if (!s_tx->writeValue((const uint8_t*)line.c_str(), line.length(), !noRsp)) return String();

  if (xSemaphoreTake(s_prompt, pdMS_TO_TICKS(timeoutMs)) != pdTRUE) {
    Serial.printf("[obd] timeout on %s\n", c);
    return String();
  }
  char local[sizeof(s_buf)];
  size_t n;
  portENTER_CRITICAL(&s_mux);
  n = s_len;
  memcpy(local, s_buf, n);
  portEXIT_CRITICAL(&s_mux);
  return clean(local, n);
}

bool initElm() {
  String r = cmd("ATZ", OBD_INIT_TIMEOUT_MS);
  Serial.printf("[obd] ATZ -> %s\n", r.c_str());
  const char* setup[] = {"ATE0", "ATL0", "ATS0", "ATH0", "ATAT1", "ATSP0"};
  for (auto* s : setup) {
    r = cmd(s, OBD_CMD_TIMEOUT_MS);
    Serial.printf("[obd] %s -> %s\n", s, r.c_str());
  }
  Serial.printf("[obd] STI -> %s\n", cmd("STI", OBD_CMD_TIMEOUT_MS).c_str());
  Serial.printf("[obd] ATRV -> %s\n", cmd("ATRV", OBD_CMD_TIMEOUT_MS).c_str());
  // 0100 forces protocol detection. Fails with engine/ignition off, which is fine.
  r = cmd("0100", OBD_INIT_TIMEOUT_MS);
  Serial.printf("[obd] 0100 -> %s\n", r.c_str());
  Serial.printf("[obd] ATDPN -> %s\n", cmd("ATDPN", OBD_CMD_TIMEOUT_MS).c_str());
  return r.indexOf("4100") >= 0;
}

}  // namespace obd
