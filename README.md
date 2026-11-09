# vette-telemetry

C8 Stingray logger. OBDLink CX (BLE) -> ESP32-S3 -> LTE -> Cloudflare Worker + D1 -> MCP -> Claude.

```
firmware/   PlatformIO, Arduino + NimBLE. envs: atoms3 (prototype), sim7670g (car)
backend/    Cloudflare Worker: POST /ingest (device), POST /mcp/<secret> (Claude connector)
```

## Firmware

Build: `pio run -e atoms3` or `pio run -e sim7670g`. Flash and monitor: `pio run -e atoms3 -t upload -t monitor`.

Copy `firmware/include/secrets.example.h` to `secrets.h` first (gitignored).

### Step 1 checklist (AtomS3 + CX, Nov 9)

1. Flash `atoms3`, open the monitor, car in run or engine running.
2. It scans for `OBDLink*`, connects, and prints the full GATT table. Expect service `fff0` with `fff1 N` and `fff2 W WnR`. If the CX uses something else the code falls back to the first notify+write pair, but update `config.h` to match.
3. Init log shows `ATZ`, `STI` (STN firmware id), `ATRV`, `0100`, `ATDPN`. Expect protocol 6 (CAN 11-bit 500k).
4. Then one line per second: rpm, speed, temps, MAF, throttle, fuel, volts, instant MPG, trip totals.
5. If subscribe fails, pairing was rejected. Press the CX button and reset the AtomS3.
6. Raw console: type `>22xxxx` or `>ATSH7E0` etc. in the monitor to send anything to the adapter. Use this for Mode 22 research. `q` prints queue size.

### Design notes

- **Battery guard.** Every cycle starts with `ATRV`, which the adapter answers itself with no CAN traffic. Below 13.0 V for 20 s (engine not charging) the firmware stops querying ECUs and only probes `ATRV` every 10 s, so retained accessory power never keeps modules awake.
- **Power-loss safety.** Fixed 48-byte CRC'd records (`include/record.h`) appended to LittleFS segments, fsync every 5 records. A new segment every boot and every upload cycle, so a torn record can only be at the tail of a closed file. Backend drops it. Worst case loss on power cut: ~5 s logged plus whatever was not uploaded yet (that uploads next drive).
- **Upload.** Raw binary records every 30 s, oldest first, deleted only after a 2xx. Re-uploads are idempotent on `(boot, ms)`. Queue capped at 4 MB.
- **Time.** Records carry `boot` + `millis`. Epoch comes from GNSS or NITZ (`AT+CCLK`) when available. The backend backfills times for records written before the clock was known.
- **Speed.** PID requests are sent as `010C1`. The trailing `1` tells the STN to return after the first ECU reply instead of waiting out the timeout. Slow PIDs (fuel, ECU volts, odometer A6) every 10th cycle. PIDs that return NO DATA 3 times are skipped for the session.
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
