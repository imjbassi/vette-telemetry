// WiFi backend for desk testing on the AtomS3. No GNSS. Time from SNTP.
#if HAS_WIFI
#include "net_common.h"
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <time.h>
#include "secrets.h"

namespace net {

static uint32_t s_lastTry = 0;

bool begin() {
  if (strlen(WIFI_SSID) == 0) { Serial.println("[wifi] no SSID configured, upload disabled"); return false; }
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  configTime(0, 0, "pool.ntp.org", "time.cloudflare.com");
  s_lastTry = millis();
  return true;
}

bool ready() { return WiFi.status() == WL_CONNECTED; }

void service() {
  if (strlen(WIFI_SSID) == 0) return;
  if (!ready() && millis() - s_lastTry > 15000) { WiFi.reconnect(); s_lastTry = millis(); }
  time_t now = time(nullptr);
  if (now > 1700000000 && epochBase() == 0) state::setEpochNow((uint32_t)now);
  int rssi = WiFi.RSSI();  // map dBm to a CSQ-like 0..31 scale
  state::csq = ready() ? (uint8_t)constrain((rssi + 113) / 2, 0, 31) : 99;
}

int checkBackend() {
  if (!ready()) return -1;
  WiFiClientSecure tls;
  tls.setInsecure();
  HTTPClient http;
  if (!http.begin(tls, String("https://") + INGEST_HOST + "/health")) return -2;
  http.setTimeout(15000);
  int code = http.GET();
  http.end();
  return code;
}

int post(const uint8_t* body, size_t len) {
  if (!ready()) return -1;
  WiFiClientSecure tls;
  tls.setInsecure();  // desk testing only. The modem path is the production path.
  HTTPClient http;
  String url = String("https://") + INGEST_HOST + INGEST_PATH;
  if (!http.begin(tls, url)) return -2;
  http.addHeader("Content-Type", "application/octet-stream");
  http.addHeader("Authorization", String("Bearer ") + DEVICE_TOKEN);
  http.setTimeout(15000);
  int code = http.POST(const_cast<uint8_t*>(body), len);
  http.end();
  return code;
}

}  // namespace net
#endif
