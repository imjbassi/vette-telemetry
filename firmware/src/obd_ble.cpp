#include "obd_ble.h"
#include <NimBLEDevice.h>
#include <Preferences.h>
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

// OBDLink CX: link is always encrypted, bonding is only accepted during the first
// 5 minutes after the adapter powers on, legacy pairing PIN is 123456.
static const uint32_t kLegacyPin = 123456;
static const uint8_t kBondVersion = 2;  // bump to force a one-time bond wipe

void disconnect();

class ClientCb : public NimBLEClientCallbacks {
  void onConnect(NimBLEClient*) override { s_connected = true; }
  void onDisconnect(NimBLEClient*) override {
    s_connected = false;
    Serial.println("[ble] disconnected");
  }
  uint32_t onPassKeyRequest() override {
    Serial.println("[ble] passkey requested, sending 123456");
    return kLegacyPin;
  }
  bool onConfirmPIN(uint32_t pin) override {
    Serial.printf("[ble] confirm pin %06lu\n", (unsigned long)pin);
    return true;
  }
  void onAuthenticationComplete(ble_gap_conn_desc* d) override {
    Serial.printf("[ble] security: encrypted=%d bonded=%d authenticated=%d key_size=%d\n",
                  d->sec_state.encrypted, d->sec_state.bonded, d->sec_state.authenticated,
                  d->sec_state.key_size);
  }
};
static ClientCb s_cb;

bool begin() {
  s_prompt = xSemaphoreCreateBinary();
  NimBLEDevice::init("");
  NimBLEDevice::setPower(ESP_PWR_LVL_P9);
  // Bond, no MITM requirement, LE secure connections when the peer supports it.
  // Keyboard-only IO lets us answer a legacy passkey request with 123456 and
  // otherwise falls back to Just Works.
  NimBLEDevice::setSecurityAuth(true, false, true);
  NimBLEDevice::setSecurityIOCap(BLE_HS_IO_KEYBOARD_ONLY);
  // Exchange encryption keys only. The CX hands out an all-zero identity address, and
  // storing it makes later scans report the adapter as 00:00:00:00:00:00.
  NimBLEDevice::setSecurityInitKey(BLE_SM_PAIR_KEY_DIST_ENC);
  NimBLEDevice::setSecurityRespKey(BLE_SM_PAIR_KEY_DIST_ENC);

  // Bonds made by earlier firmware carry that bad identity. Drop them once.
  Preferences p;
  p.begin("vette", false);
  if (p.getUChar("bondv", 0) != kBondVersion) {
    Serial.println("[ble] clearing old bonds (pair again within 5 min of plugging in the CX)");
    NimBLEDevice::deleteAllBonds();
    p.putUChar("bondv", kBondVersion);
  }
  p.end();
  return true;
}

void forgetBonds() {
  disconnect();
  NimBLEDevice::deleteAllBonds();
  Serial.println("[ble] bonds deleted. Replug the CX, then it will pair again.");
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

  // Match on name prefix (case-insensitive) or the advertised FFF0 service, since some
  // adapters only put the name in the scan response or not at all.
  static const NimBLEUUID kSvc(OBD_SERVICE_UUID);
  NimBLEAdvertisedDevice* target = nullptr;
  for (auto it = res.begin(); it != res.end(); ++it) {
    std::string name = (*it)->getName();
    std::string lower = name;
    for (auto& ch : lower) ch = (char)tolower((unsigned char)ch);
    std::string prefix = OBD_NAME_PREFIX;
    for (auto& ch : prefix) ch = (char)tolower((unsigned char)ch);
    bool svc = (*it)->isAdvertisingService(kSvc);
    bool match = svc || (!name.empty() && lower.rfind(prefix, 0) == 0);
    if (!name.empty() || svc) {
      Serial.printf("  seen %s \"%s\" rssi %d%s\n", (*it)->getAddress().toString().c_str(), name.c_str(),
                    (*it)->getRSSI(), svc ? " [FFF0]" : "");
    }
    if (!target && match) target = *it;
  }
  if (!target) {
    Serial.println("[ble] OBDLink not found");
    scan->clearResults();
    return false;
  }

  // Self-heal: a null address means a stored bond has a bad identity for this adapter.
  if (target->getAddress().toString() == "00:00:00:00:00:00") {
    Serial.println("[ble] adapter resolved to a null address, deleting bonds and rescanning");
    scan->clearResults();
    NimBLEDevice::deleteAllBonds();
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

  // The CX drops traffic on an unencrypted link. Start encryption ourselves: this
  // pairs on first contact and re-encrypts with the stored bond afterwards.
  if (!s_client->secureConnection()) {
    Serial.println("[ble] pairing/encryption failed. The CX only accepts new bonds for 5 min after");
    Serial.println("      power-up: unplug it for 10 s, plug it back in, then reset the AtomS3.");
    disconnect();
    return false;
  }

  dumpGatt(s_client);
  if (!pickChars(s_client)) { Serial.println("[ble] no usable chars"); disconnect(); return false; }
  Serial.printf("[ble] rx %s  tx %s\n", s_rx->getUUID().toString().c_str(), s_tx->getUUID().toString().c_str());
  // response=true: enable notifications with an acknowledged write. The library default
  // is an unacknowledged write, which the CX ignores, so no replies ever arrive.
  if (!s_rx->subscribe(true, onNotify, true)) {
    Serial.println("[ble] subscribe failed (notifications not enabled)");
    disconnect();
    return false;
  }
  Serial.println("[ble] notifications enabled");
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
  // OBDLink's reference code uses acknowledged writes. Use them when available.
  bool withRsp = s_tx->canWrite();
  if (!s_tx->writeValue((const uint8_t*)line.c_str(), line.length(), withRsp)) {
    Serial.printf("[obd] write failed for %s\n", c);
    return String();
  }

  if (xSemaphoreTake(s_prompt, pdMS_TO_TICKS(timeoutMs)) != pdTRUE) {
    // Byte count separates "adapter silent" from "replied without a prompt".
    Serial.printf("[obd] timeout on %s (%u bytes received)\n", c, (unsigned)s_len);
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
