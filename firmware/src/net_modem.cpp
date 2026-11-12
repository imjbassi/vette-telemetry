// SIM7670G (SIMCom A76xx command set) backend: LTE data, HTTPS via the modem's own
// HTTP stack, GNSS position, network time. Everything runs on the net task.
#if HAS_MODEM
#include "net_common.h"
#include "config.h"
#include "coord.h"
#include "net_policy.h"
#include "secrets.h"

#define MODEM Serial1

namespace net {

static bool s_ready = false;
static bool s_uartUp = false;    // MODEM.begin() has run. begin() can be called again.
static bool s_settingsFresh = false;  // settings were applied since the modem last answered begin()
static netpol::RestartWatch s_restart;  // notices a modem that restarted by its echo. See net_policy.h
static uint32_t s_lastGnss = 0, s_lastCsq = 0, s_lastClk = 0, s_lastReg = 0;

static String readLine(uint32_t deadline) {
  String line;
  while ((int32_t)(deadline - millis()) > 0) {
    while (MODEM.available()) {
      char c = (char)MODEM.read();
      if (c == '\n') { line.trim(); if (line.length()) return line; continue; }
      if (c != '\r') line += c;
    }
    vTaskDelay(pdMS_TO_TICKS(5));
  }
  line.trim();
  return line;
}

// Sends cmd, collects lines until "OK", "ERROR" or `expect`. ok is true only on expect.
static String at(const String& cmd, uint32_t timeoutMs = 2000, const char* expect = "OK", bool* ok = nullptr) {
  while (MODEM.available()) MODEM.read();
  MODEM.print(cmd);
  MODEM.print("\r");
  String all;
  uint32_t deadline = millis() + timeoutMs;
  bool good = false;
  while ((int32_t)(deadline - millis()) > 0) {
    String l = readLine(deadline);
    if (!l.length()) continue;
    if (l == cmd) { s_restart.onEcho(); continue; }  // echo: ATE0 not sent yet, or lost in a modem restart
    all += l; all += '\n';
    if (l.startsWith(expect)) { good = true; break; }
    if (l.indexOf("ERROR") >= 0) break;
  }
  if (ok) *ok = good;
  return all;
}

static bool atOk(const String& cmd, uint32_t timeoutMs = 2000) {
  bool ok;
  at(cmd, timeoutMs, "OK", &ok);
  return ok;
}

// Wait for an unsolicited line starting with prefix.
static String waitUrc(const char* prefix, uint32_t timeoutMs) {
  uint32_t deadline = millis() + timeoutMs;
  while ((int32_t)(deadline - millis()) > 0) {
    String l = readLine(deadline);
    if (l.startsWith(prefix)) return l;
  }
  return String();
}

static int field(const String& s, char sep, int idx, String& out) {
  int start = 0;
  for (int i = 0; i < idx; i++) {
    start = s.indexOf(sep, start);
    if (start < 0) return -1;
    start++;
  }
  int end = s.indexOf(sep, start);
  out = s.substring(start, end < 0 ? s.length() : end);
  out.trim();
  return 0;
}

// Echo off and verbose errors.
static void applyBasics() {
  atOk("ATE0");
  atOk("AT+CMEE=2");
}

// TLS context and GNSS power. The modem does not keep these across a reset.
// True when the modem took the GNSS power command. One that is still starting up does not.
static bool applyTlsAndGnss() {
  // TLS context 0 for the modem's HTTP stack: any TLS version, send SNI (Cloudflare needs
  // it), no server certificate check, and do not reject certs because the clock is unset.
  // Same trust level as the WiFi path's setInsecure(). Failures here are not fatal.
  const char* ssl[] = {
      "AT+CSSLCFG=\"sslversion\",0,4",
      "AT+CSSLCFG=\"authmode\",0,0",
      "AT+CSSLCFG=\"enableSNI\",0,1",
      "AT+CSSLCFG=\"ignorelocaltime\",0,1",
  };
  for (auto* c : ssl) {
    if (!atOk(c)) Serial.printf("[modem] %s not accepted\n", c);
  }

  bool gnss = atOk("AT+CGNSSPWR=1", 5000);
  if (!gnss) Serial.println("[modem] GNSS power-on not accepted");
  return gnss;
}

// Echo off, clock update, TLS and GNSS once more, for a modem that may have forgotten them.
static void reapplySettings(const char* why) {
  Serial.printf("[modem] %s, applying modem settings again\n", why);
  applyBasics();
  atOk("AT+CTZU=1");
  s_restart.applied(millis(), applyTlsAndGnss());
}

// Called every NET_BEGIN_RETRY_MS by the net task until it returns true.
bool begin() {
  if (!s_uartUp) {
    MODEM.setRxBufferSize(4096);
    MODEM.begin(MODEM_BAUD, SERIAL_8N1, MODEM_RX_PIN, MODEM_TX_PIN);
    s_uartUp = true;
  }
  Serial.println("[modem] waiting for AT");
  uint32_t t0 = millis();
  while (!atOk("AT", 500)) {
    if (millis() - t0 > 30000) { Serial.println("[modem] no response"); return false; }
    vTaskDelay(pdMS_TO_TICKS(500));
  }
  applyBasics();
  Serial.printf("[modem] %s", at("ATI").c_str());
  Serial.printf("[modem] ICCID %s", at("AT+CICCID").c_str());  // EIOTCLUB APN depends on prefix
  String pin = at("AT+CPIN?", 5000);
  if (pin.indexOf("READY") < 0) Serial.printf("[modem] SIM not ready: %s", pin.c_str());
  atOk("AT+CTZU=1");  // let NITZ update the RTC

  // The APN is stored in the modem and used when it attaches. If ours is not there yet,
  // set it and bounce the radio so the attach is redone with it.
  String ctx = at("AT+CGDCONT?");
  if (ctx.indexOf(String("\"") + MODEM_APN + "\"") < 0) {
    Serial.printf("[modem] setting APN \"%s\" and re-attaching\n", MODEM_APN);
    atOk(String("AT+CGDCONT=1,\"IP\",\"") + MODEM_APN + "\"");
    atOk("AT+CFUN=0", 10000);
    atOk("AT+CFUN=1", 10000);
  } else {
    Serial.printf("[modem] APN \"%s\" already set\n", MODEM_APN);
  }

  applyTlsAndGnss();
  s_settingsFresh = true;
  s_restart.clear();  // the first AT of a fresh modem is echoed. Everything was set after it.
  s_lastReg = 0;
  return true;
}

bool ready() { return s_ready; }

static void readCsqNow() {
  String r = at("AT+CSQ");  // +CSQ: 20,99
  int c = r.indexOf("+CSQ:");
  if (c >= 0) state::csq = (uint8_t)r.substring(c + 5).toInt();
}

static void checkRegistration() {
  String r = at("AT+CEREG?");  // +CEREG: 0,1  (1 home, 5 roaming)
  int c = r.indexOf("+CEREG:");
  bool reg = false;
  int st = -1;
  if (c >= 0) {
    String stat;
    field(r.substring(c + 7), ',', 1, stat);
    st = stat.toInt();
    reg = st == 1 || st == 5;
  }
  if (!reg) {
    // 0 idle, 2 searching, 3 denied (SIM not active or wrong plan), 4 unknown
    static uint8_t n = 0;
    if (n++ % 4 == 0) {
      readCsqNow();
      Serial.printf("[modem] not registered yet (state %d%s, signal %u/31)\n", st,
                    st == 3 ? " = denied: is the SIM plan active?" : st == 2 ? " = searching" : "", state::csq);
    }
    s_ready = false;
    return;
  }
  if (!s_ready) {
    atOk("AT+CGATT=1", 10000);
    atOk("AT+CGACT=1,1", 15000);
    String ip = at("AT+CGPADDR=1");
    s_ready = ip.indexOf('.') > 0;
    Serial.printf("[modem] data %s: %s", s_ready ? "up" : "down", ip.c_str());
    if (s_ready) {
      // The link was lost and is back. The modem may have restarted in between (a voltage
      // dip while cranking is enough) and then it has forgotten echo, TLS, SNI and GNSS
      // power. Setting them again costs a second and is harmless when nothing was lost.
      // Skipped once right after begin(), which has just set them, unless an echo since
      // then shows that the modem restarted after begin().
      if (!s_settingsFresh || s_restart.seen()) reapplySettings("data link is back");
      s_settingsFresh = false;
    }
  }
}

static void readCsq() { readCsqNow(); }

// +CCLK: "24/11/09,12:34:56-32"  (tz in quarter hours, local time)
static void readClock() {
  String r = at("AT+CCLK?");
  int q = r.indexOf('"');
  if (q < 0) return;
  int yy, MM, dd, hh, mm, ss, tz = 0;
  char sign = '+';
  if (sscanf(r.c_str() + q + 1, "%d/%d/%d,%d:%d:%d%c%d", &yy, &MM, &dd, &hh, &mm, &ss, &sign, &tz) < 6) return;
  if (yy < 24 || yy > 60) return;  // RTC not synced yet
  // On the SIM7670G (V1.9.05) the clock fields are already UTC and the zone suffix is only
  // informational. Applying the offset put every record 8 h in the future. GNSS time, when
  // it arrives, replaces this anyway.
  (void)sign; (void)tz;
  if (epochBase() == 0) Serial.println("[time] provisional time from the cell network clock");
  state::setEpochNow(state::toUnix(2000 + yy, MM, dd, hh, mm, ss));
}

// The text-to-number step is coordToE7() in coord.h. It handles NMEA ddmm.mmmm and the
// plain decimal degrees the SIM7670G sends.

// +CGNSSINFO: 3,08,,04,00,37.819900,N,122.478300,W,010126,120000.00,...   (SIM7670G)
// +CGNSSINFO: 2,09,05,00,3113.330650,N,12121.262554,E,131117,091918.0,...  (older A76xx)
// Firmware revisions differ in how many satellite-count fields precede lat, so anchor on N/S.
static void readGnss() {
  String r = at("AT+CGNSSINFO", 3000);
  int c = r.indexOf("+CGNSSINFO:");
  if (c < 0) return;
  String body = r.substring(c + 11);
  body = body.substring(0, body.indexOf('\n'));
  String tok[24];
  int n = 0, start = 0;
  while (n < 24) {
    int e = body.indexOf(',', start);
    tok[n] = body.substring(start, e < 0 ? body.length() : e);
    tok[n].trim();
    n++;
    if (e < 0) break;
    start = e + 1;
  }
  int ns = -1;
  for (int i = 1; i < n; i++) if (tok[i] == "N" || tok[i] == "S") { ns = i; break; }
  Fix f;
  if (ns >= 1 && ns + 4 < n && tok[ns - 1].length()) {
    f.valid = true;
    f.lat_e7 = coordToE7(tok[ns - 1].c_str(), tok[ns] == "S", true);
    f.lon_e7 = coordToE7(tok[ns + 1].c_str(), tok[ns + 2] == "W", false);
    static bool logged = false;
    if (!logged) {
      logged = true;
      Serial.printf("[gnss] first fix %.6f, %.6f (%s)\n", f.lat_e7 / 1e7, f.lon_e7 / 1e7, tok[ns - 1].c_str());
    }
    int sats = 0;
    for (int i = 1; i < ns - 1; i++) sats += tok[i].toInt();
    f.sats = (uint8_t)min(sats, 255);
    // date ddmmyy, time hhmmss.s (UTC)
    const String& d = tok[ns + 3];
    const String& t = tok[ns + 4];
    if (d.length() >= 6 && t.length() >= 6) {
      uint32_t u = state::toUnix(2000 + d.substring(4, 6).toInt(), d.substring(2, 4).toInt(), d.substring(0, 2).toInt(),
                                 t.substring(0, 2).toInt(), t.substring(2, 4).toInt(), t.substring(4, 6).toInt());
      if (u > 1700000000) state::setEpochNow(u);
    }
  }
  portENTER_CRITICAL(&state::mux);
  state::fix = f;
  portEXIT_CRITICAL(&state::mux);
}

void service() {
  uint32_t now = millis();
  if (!s_ready && now - s_lastReg > 5000) { s_lastReg = now; checkRegistration(); }
  // A modem that restarted while the data link looks up is only noticed here. Without
  // this, uploads could go on with the modem's defaults and GNSS would stay off.
  if (s_restart.due(now)) reapplySettings("the modem restarted");
  if (now - s_lastGnss > GNSS_PERIOD_MS) { s_lastGnss = now; readGnss(); }
  if (now - s_lastCsq > 30000) { s_lastCsq = now; readCsq(); }
  if (epochBase() == 0 && now - s_lastClk > 10000) { s_lastClk = now; readClock(); }
}

int post(const uint8_t* body, size_t len) {
  if (!s_ready) return -1;
  at("AT+HTTPTERM");  // clear any stale session, ignore result
  if (!atOk("AT+HTTPINIT", 5000)) { s_ready = false; return -2; }
  int code = -3;
  do {
    atOk("AT+HTTPPARA=\"SSLCFG\",0");  // use TLS context 0 from begin(). Optional on some firmware.
    if (!atOk(String("AT+HTTPPARA=\"URL\",\"https://") + INGEST_HOST + INGEST_PATH + "\"")) break;
    if (!atOk("AT+HTTPPARA=\"CONTENT\",\"application/octet-stream\"")) break;
    if (!atOk(String("AT+HTTPPARA=\"USERDATA\",\"Authorization: Bearer ") + DEVICE_TOKEN + "\"")) break;
    bool ok;
    at(String("AT+HTTPDATA=") + len + ",20000", 5000, "DOWNLOAD", &ok);
    if (!ok) { code = -4; break; }
    MODEM.write(body, len);
    if (waitUrc("OK", 20000).length() == 0) { code = -5; break; }
    if (!atOk("AT+HTTPACTION=1", 5000)) { code = -6; break; }
    String urc = waitUrc("+HTTPACTION:", 60000);  // +HTTPACTION: 1,200,17
    String st;
    if (!urc.length() || field(urc, ',', 1, st) < 0) { code = -7; break; }
    code = st.toInt();
  } while (false);
  at("AT+HTTPTERM");
  // 7xx are modem-side network/TLS errors. Force a registration re-check.
  if (code < 0 || code >= 700) s_ready = false;
  return code;
}

// GET /health over the same HTTPS path the uploads use. Lets a desk test prove the TLS
// and backend side before any car data exists.
int checkBackend() {
  if (!s_ready) return -1;
  at("AT+HTTPTERM");
  if (!atOk("AT+HTTPINIT", 5000)) return -2;
  int code = -3;
  do {
    atOk("AT+HTTPPARA=\"SSLCFG\",0");
    if (!atOk(String("AT+HTTPPARA=\"URL\",\"https://") + INGEST_HOST + "/health\"")) break;
    if (!atOk("AT+HTTPACTION=0", 5000)) { code = -6; break; }
    String urc = waitUrc("+HTTPACTION:", 60000);  // +HTTPACTION: 0,200,11
    String st;
    if (!urc.length() || field(urc, ',', 1, st) < 0) { code = -7; break; }
    code = st.toInt();
  } while (false);
  at("AT+HTTPTERM");
  return code;
}

}  // namespace net
#endif
