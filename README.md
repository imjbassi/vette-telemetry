# vette-telemetry

C8 Stingray logger. OBDLink CX (BLE) -> ESP32-S3 -> LTE -> Cloudflare Worker + D1 -> MCP -> Claude.

```
firmware/   PlatformIO, Arduino + NimBLE. envs: atoms3 (prototype), sim7670g (car)
backend/    Cloudflare Worker: POST /ingest (device), POST /mcp/<secret> (Claude connector)
```

## Firmware

Build: `pio run -e atoms3` or `pio run -e sim7670g`. Flash and monitor: `pio run -e atoms3 -t upload -t monitor`.

Copy `firmware/include/secrets.example.h` to `secrets.h` first (gitignored).

### Step 1 checklist (AtomS3 + CX)

1. Unplug the CX for 10 s and plug it back in. It only accepts a new pairing during the first 5 minutes after power-up. Start the engine.
2. Flash `atoms3` and open the monitor. It scans for `OBDLink*` (or the `FFF0` service), connects, pairs, and prints the GATT table. Expect `security: encrypted=1 bonded=1`, service `fff0` with `fff1 N` and `fff2 W WnR`, then `notifications enabled`.
3. Init log shows `ATZ -> ELM327 v1.4b`, `STI -> STN2310 ...`, `ATRV`. Nothing is sent to the car yet.
4. With the engine running: `[pid] ECU supports: ...`, then one line per second: rpm, speed, temps, MAF, throttle, fuel, volts, instant MPG, trip totals. `--` means no value for that field.
5. Raw console: type `>22xxxx` or `>ATSH7E0` etc. in the monitor to send anything to the adapter. Use this for Mode 22 research. `q` prints queue size. `unpair` erases stored pairings and reboots.

### OBDLink CX notes (learned the hard way)

- The link must be encrypted. Unpaired, the CX accepts writes and silently drops them. Pairing uses passkey 123456 and is only possible for 5 minutes after the CX powers up. The pairing then persists on both sides, so each ESP32 board needs this once.
- Notifications must be enabled with an acknowledged write (`subscribe(true, cb, true)`). NimBLE's default unacknowledged write is ignored.
- The CX distributes an all-zero identity address. If NimBLE stores it (host-based privacy peer record), every later scan reports the CX as `00:00:00:00:00:00` and `deleteAllBonds()` does not clear it. The firmware pairs with encryption keys only and can erase the `nimble_bond` NVS namespace.
- The protocol is fixed to 6 (CAN 11-bit 500k). With `ATSP0` and the engine off, every request starts a multi-second `SEARCHING...` pass that a 1 Hz poller keeps aborting (`STOPPED`).

### Design notes

- **Battery guard.** Every cycle starts with `ATRV`, which the adapter answers itself with no CAN traffic. The car is only queried while the engine runs. Charging voltage (13.0 V or more) plus an answering ECU starts polling. RPM above zero keeps it going, because GM's charging control can drop below 13 V while cruising. No RPM and no charging for 20 s goes quiet. While quiet and not charging, one RPM request every 30 s checks for a running engine.
- **Power-loss safety.** Fixed 48-byte CRC'd records (`include/record.h`) appended to LittleFS segments, fsync every 5 records. A new segment every boot and every upload cycle, so a torn record can only be at the tail of a closed file. Backend drops it. Worst case loss on power cut: ~5 s logged plus whatever was not uploaded yet (that uploads next drive).
- **Upload.** Raw binary records every 30 s, oldest first, deleted only after a 2xx. Re-uploads are idempotent on `(boot, ms)`. Queue capped at 4 MB.
- **Time.** Records carry `boot` + `millis`. Epoch comes from GNSS or NITZ (`AT+CCLK`) when available. The backend backfills times for records written before the clock was known.
- **Speed.** PID requests are sent as `010C1`. The trailing `1` tells the STN to return after the first ECU reply instead of waiting out the timeout. Slow PIDs (fuel, ECU volts, odometer A6) every 10th cycle. The ECU's supported-PID bitmasks (`0100`, `0120`, ...) decide what gets asked. A supported PID that still returns NO DATA 3 times is skipped for the session.
- **MPG** = speed / (MAF x 3600 / (14.7 x 2798.7 g/gal)). LT2 runs stoich in cruise, so this tracks well except under power enrichment.

### sim7670g bring-up (Nov 10)

- Modem UART: ESP32 RX 17, TX 18, 115200 (from community reports, not an official Waveshare example. Verify against the board schematic).
- Boot log prints `ATI` and `ICCID`. **EIOTCLUB's APN depends on the ICCID prefix.** Check it against their APN table and set `MODEM_APN`. `america.bics` is a guess for a US IoT SIM.
- Serial logs go out UART0 via the onboard CH343 (`ARDUINO_USB_CDC_ON_BOOT=0`). If the monitor is silent, flip it to 1.
- HTTPS uses the modem's own HTTP stack (`AT+HTTPINIT/HTTPPARA/HTTPDATA/HTTPACTION`). Someone reported URL truncation near 64 chars on this board, so keep `INGEST_HOST` short. If you see 7xx codes from `HTTPACTION`, it is a TLS/SNI issue, and the next step is `AT+HTTPPARA="SSLCFG"` with an SSL context.
- The board may need a PWRKEY pulse to power the modem. Not wired up yet since it is unconfirmed.

### Not done yet

- GM Mode 22 PIDs (oil life, trans fluid/filter life). Codes need research. The `>` console is the tool for it.
- Odometer: PID A6 may not be supported on the C8 ECM. The firmware detects and skips it.
- Boot counter lives in NVS. Erasing flash restarts it at 1 and new trips would overwrite old ones in D1. Do not erase NVS once deployed (or bump the counter manually).

## Backend

```bash
cd backend
npm install
npx wrangler d1 create vette            # paste database_id into wrangler.toml
npm run db:init:remote
npx wrangler secret put DEVICE_TOKEN    # same value as DEVICE_TOKEN in secrets.h
npx wrangler secret put MCP_SECRET      # long random string
npm run deploy
```

Set `LOCAL_TZ` in `wrangler.toml` to your zone.

Local test without hardware:

```bash
npm run db:init:local
npm run dev
node scripts/fake-device.mjs            # simulated 20 min drive, incl. no-clock start and torn tail
node scripts/mcp-smoke.mjs              # calls every MCP tool
```

### Claude connector

Settings > Connectors > Add custom connector, URL `https://<worker-host>/mcp/<MCP_SECRET>`. The secret path is the auth, so treat the URL like a password.

Tools: `get_latest_status`, `get_location`, `get_trip_summary`, `list_trips`, `get_fuel_economy`.

A trip is one ignition cycle (one device boot with the engine on).
