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
- The 2024 C8 answers on protocol 7 (CAN 29-bit 500k), not 6. The protocol is fixed to that. With `ATSP0` and the engine off, every request starts a multi-second `SEARCHING...` pass that a 1 Hz poller keeps aborting (`STOPPED`).

### Design notes

- **Battery guard.** Every cycle starts with `ATRV`, which the adapter answers itself with no CAN traffic. The car is only queried while the engine runs. Charging voltage (13.0 V or more) plus an answering ECU starts polling. RPM above zero keeps it going, because GM's charging control can drop below 13 V while cruising. No RPM and no charging for 20 s goes quiet. While quiet and not charging, one RPM request every 30 s checks for a running engine.
- **Power-loss safety.** Fixed 48-byte CRC'd records (`include/record.h`) appended to LittleFS segments, fsync every 5 records. A new segment every boot and every upload cycle, so a torn record can only be at the tail of a closed file. Backend drops it. Worst case loss on power cut: ~5 s logged plus whatever was not uploaded yet (that uploads next drive).
- **Upload.** Raw binary records every 30 s, oldest first, deleted only after a 2xx. Re-uploads are idempotent on `(boot, ms)`. Queue capped at 4 MB.
- **Time.** Records carry `boot` + `millis`. Epoch comes from GNSS or NITZ (`AT+CCLK`) when available. The backend backfills times for records written before the clock was known.
- **Speed.** PID requests are sent as `010C1`. The trailing `1` tells the STN to return after the first ECU reply instead of waiting out the timeout. Slow PIDs (fuel, ECU volts, odometer A6) every 10th cycle. The ECU's supported-PID bitmasks (`0100`, `0120`, ...) decide what gets asked. A supported PID that still returns NO DATA 3 times is skipped for the session.
- **MPG** = speed / (MAF x 3600 / (14.7 x 2798.7 g/gal)). LT2 runs stoich in cruise, so this tracks well except under power enrichment.

### sim7670g bring-up (Nov 10)

- DIP switches: `4G` on (powers the modem), `HUB` on (needed for USB flashing and serial), `CAM` off, `USB` off (keeps the modem's own USB off the cable so the computer sees one serial port).
- LTE uses the onboard antenna. GPS needs the external antenna on the GNSS connector and a view of the sky.
- First boot needs the CX pairing window again: replug the CX, and keep the AtomS3 unpowered so it does not take the connection.
- Modem UART: ESP32 RX 17, TX 18, 115200 (from two community sources, one quoting a Waveshare support sample. Not in the official docs).
- The modem's TLS context skips server certificate checks (`authmode 0`), like the WiFi path. Pinning Cloudflare's root CA is a possible hardening step.
- Boot log prints `ATI` and `ICCID`. **EIOTCLUB's APN depends on the ICCID prefix.** Check it against their APN table and set `MODEM_APN`. `america.bics` is a guess for a US IoT SIM.
- Serial logs go out UART0 via the onboard CH343 (`ARDUINO_USB_CDC_ON_BOOT=0`). If the monitor is silent, flip it to 1.
- HTTPS uses the modem's own HTTP stack (`AT+HTTPINIT/HTTPPARA/HTTPDATA/HTTPACTION`). Someone reported URL truncation near 64 chars on this board, so keep `INGEST_HOST` short. If you see 7xx codes from `HTTPACTION`, it is a TLS/SNI issue, and the next step is `AT+HTTPPARA="SSLCFG"` with an SSL context.
- The board may need a PWRKEY pulse to power the modem. Not wired up yet since it is unconfirmed.

### Not done yet

- GM Mode 22 PIDs (oil life, trans fluid/filter life). Codes need research. The `>` console is the tool for it.
- Not yet verified on the road: speed, MPG, trip totals, quiet mode after shutdown, upload.
- Boot counter lives in NVS. Erasing flash restarts it at 1 and new trips would overwrite old ones in D1. Do not erase NVS once deployed (or bump the counter manually).

## Backend

```bash
cd backend
npm install
npx wrangler login
npm run setup
```

`npm run setup` is safe to re-run. It finds or creates the D1 database, loads the schema, deploys the Worker, generates `DEVICE_TOKEN` and `MCP_SECRET` once and stores them as Worker secrets, fills `INGEST_HOST` and `DEVICE_TOKEN` into `firmware/include/secrets.h`, writes the connector URL to `backend/.secrets/connector-url.txt`, and checks the live Worker. Account-specific files (`wrangler.local.toml`, `.secrets/`) are gitignored. Later code changes: `npm run deploy`.

Set `LOCAL_TZ` in `wrangler.toml` to your zone, then run setup again.

Local test without hardware:

```bash
npm run db:init:local
npm run dev
node scripts/fake-device.mjs            # simulated 20 min drive, incl. no-clock start and torn tail
node scripts/mcp-smoke.mjs              # calls every MCP tool
```

### Database cost (D1 free tier)

D1 bills every row a query scans, and the free plan allows 5 million rows read and 100,000 written per day. Raw readings live in `samples` (one per second while driving), but nothing that refreshes reads them in bulk. Each upload folds its readings into three rollups (`src/rollup.ts`): `trips` (one row per session), `minutes` (per-minute aggregates) and `track` (a GPS point every 15 s). The dashboard and Claude tools read those, so a 30-day trips lookup reads about 7 rows instead of about 15,000. Raw readings are only read for one trip's detail or CSV, the newest 200 in Logs, live updates newer than what the page already has, and History windows of an hour or less.

The page polls no faster than the logger uploads (15 s while driving, 60 s parked), stops while hidden, and pauses after 15 minutes without interaction. If the rollups ever need rebuilding (after a manual data fix), run `migrations/backfill-rollups.sql`. It is idempotent.

### Dashboard

Open the URL in `backend/.secrets/dashboard-url.txt` on any device: `https://<worker-host>/dash/<DASH_SECRET>/`. Like the connector, the secret path is the auth, so treat it like a password. On a phone, "Add to Home Screen" makes it behave like an app.

Four sections. **Overview**: fuel, range, battery, 30-day MPG, last drive's speed, per-trip MPG against EPA, location, recent trips. **Live**: speed, RPM, throttle, coolant, instant MPG, airflow, battery, intake air, fuel and cell signal with the last 10 minutes as sparklines and charts. **Trips**: every ignition cycle with a speed-colored route, stats, speed/RPM/coolant/throttle charts and CSV export. **Logs**: last upload, uploads per hour, signal, GPS, the upload log, the newest raw readings and a per-session summary. It polls every 4 to 8 s while the engine runs and every 20 to 30 s when parked, and stops while the tab is hidden. The page is `backend/src/dash.html` (no build step) and its JSON API is in `backend/src/dash.ts`. Map tiles come from OpenStreetMap, and the page only sends the site's origin as the referrer, never the secret path.

### Claude connector

Settings > Connectors > Add custom connector, URL `https://<worker-host>/mcp/<MCP_SECRET>`. The secret path is the auth, so treat the URL like a password.

Tools: `get_latest_status`, `get_location`, `get_trip_summary`, `list_trips`, `get_fuel_economy`.

A trip is one ignition cycle (one device boot with the engine on).
