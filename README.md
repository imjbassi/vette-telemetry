# vette-telemetry

C8 Stingray logger. OBD-II port -> OBDLink CX (BLE) -> ESP32-S3 with LTE modem -> Cloudflare Worker + D1 -> dashboard and MCP -> Claude.

```
firmware/   PlatformIO, Arduino + NimBLE
              sim7670g       the board in the car (LTE, GNSS)
              atoms3         AtomS3 prototype with the real CX, WiFi upload
              atoms3-bench   AtomS3 with no car and no CX, scripted adapter
backend/    Cloudflare Worker + D1
              POST /ingest          logger uploads, bearer token
              POST /mcp/<secret>    Claude connector
              GET  /dash/<secret>/  dashboard page and its JSON API
```

The Worker is live and takes real uploads. Order for any change that touches more than one piece:

1. Schema change, if the new code needs one (see Schema changes).
2. Deploy the Worker.
3. Flash the firmware.

Deploy the Worker before flashing firmware that changes the record. The Worker must understand every byte before the car sends it. `npm run deploy` checks step 1 by itself and refuses to deploy when a schema change is missing.

## Firmware

Build: `pio run -e sim7670g`, `pio run -e atoms3` or `pio run -e atoms3-bench`. Flash and monitor: `pio run -e atoms3 -t upload -t monitor`. For the car board follow Flashing the car below.

Copy `firmware/include/secrets.example.h` to `secrets.h` first (gitignored). `npm run setup` in `backend/` fills in the host and the device token.

### Host tests and bench build

- `node firmware/test/run-host-tests.mjs` compiles every `firmware/test/host/*.cpp` with the C++17 compiler on PATH (`g++`, `c++` or `clang++`) and runs it. No board and no PlatformIO needed. It covers the record layout against the golden record, the engine gate against timelines (`include/engine_gate.h`, plain C++17 with no Arduino headers), the flash queue (`include/seg_queue.h`), upload size and waits (`include/net_policy.h`), which scan result is the adapter (`include/ble_match.h`), the PID layer against a scripted adapter and GNSS coordinate parsing (`include/coord.h`).
- The golden record is the same 48 bytes in the firmware host test and in the backend test. If one side changes the layout, its test fails.
- `atoms3-bench` is the AtomS3 on the desk with no car, no CX and no network. A scripted adapter and a scripted network (`src/bench_*.cpp`) drive the real engine gate, PID layer, queue and upload code. Nothing leaves the board. The bench build keeps its records in its own queue folder, so a normal build flashed onto the same board later never uploads them.
- The scripted car repeats a 10 minute cycle: parked on a charger, start, drive with a stretch near 12.6 V, a 50 s stop, restart, stop. It answers NO DATA for speed in the first 10 s of each drive. Speed is skipped, then comes back within a minute, and the console prints `[pid] 010D keeps returning NO DATA, skipped until the next minute`.
- The scripted network fails its first bring-up on purpose, then repeats a 22 minute round: 1 minute up, 15 minutes down, 80 s of HTTP 503, 4 minutes 40 s up. From the second round on, uploads over 1440 bytes also get 503, so the logger must fall back to small uploads. After the first minute and after each outage the monitor prints `[bench] drain N PASS` when every stored record arrived exactly once and in order, or `FAIL` with the reason. How long to run it and what must show is under Flashing the car.
- The plain `atoms3` build uploads over WiFi to `INGEST_HOST` when `WIFI_SSID` is set. That is the live Worker unless you change it. Its sessions carry their own install id, so they do not collide with the car's, but they still land in the same database. Leave `WIFI_SSID` empty to keep it offline.

### Flashing the car

Nothing of firmware build 2 has run on a board yet. Do both parts in order.

**Bench run** on the desk AtomS3, with no CX:

```bash
node firmware/test/run-host-tests.mjs
cd firmware
pio run -e atoms3-bench -t upload -t monitor
```

Without an AtomS3, run the same script on the car board at the desk with `pio run -e sim7670g-bench -t upload -t monitor`. It never touches the modem or Bluetooth, so the CX pairing stays, and it keeps its records in `/qbench`, so the car's unsent queue in `/q` stays too. It does count up the boot counter. Take the board out of the car, power it from the laptop, and keep the CX away or unplugged. When the bench passes, flash `sim7670g` onto the same board (step 4 below), then put it back in the car. Save the running image (step 3) before the bench flash, not after.

Every host test must pass first. Leave the bench running for at least 45 minutes. Drain 3 comes about 42 minutes in. It is the only drain with large uploads refused, so it is the only one that runs the fallback to small uploads. The run passes when the monitor shows all of these:

- `[bench] drain 1 PASS`, `[bench] drain 2 PASS` and `[bench] drain 3 PASS`
- `[up] 3 large uploads in a row were refused, sending 30 records at a time until the next boot`
- one `[pid] trying the adapter's automatic protocol search`, about 15 s after the adapter connects

Stop and find the cause on any of these:

- `FAIL`
- `[fs] write failed` or `[fs] flash over`
- `QUEUE DROPPED RECORDS` or `CHECK LIST OVERFLOWED`
- a second protocol search
- a second `[boot]` line, which means the board rebooted

**At the car.** The Worker that understands build 2 is live since 2026-11-12, so step 2 of the deploy order is done. Run these from `firmware/`.

1. Host tests and the bench run passed.
2. Open the monitor on the old firmware: `pio device monitor -e sim7670g`. Note the CX address from its `seen <addr> "OBDLink ..."` or `[ble] connecting <addr>` line. The scan runs when the board connects, so the line may only show after a reset or a power cycle. Close the monitor.
3. Save the running image. It holds the device token, so keep it outside the repo. It is 6.25 MB and takes a few minutes.

   ```bash
   pio pkg exec -p tool-esptoolpy -- esptool.py --chip esp32s3 read_flash 0x10000 0x640000 car-app0-<date>.bin
   ```

4. Flash with a plain upload: `pio run -e sim7670g -t upload -t monitor`. It keeps the stored pairing, so the CX needs no replug. Never erase and never run `uploadfs`. An erase wipes the CX pairing, the boot counter and the unsent queue, and the CX accepts a new pairing only in the first 5 minutes after it powers up. `uploadfs` wipes the unsent queue.
5. In the monitor expect:
   - `[boot] vette-telemetry fw 2, inst <n>, boot #<k>`
   - `seen <addr> "OBDLink ..." ... [paired]` and `[ble] connecting <addr> (paired address)`, with the address from step 2
   - `[up] ... -> 200`
   - `s` prints `[id] fw 2, inst <n>, boot <k>, session ...`, then the gate, network and upload state
6. The dashboard's Logs view shows a session `<inst>-<k>` with build 2.
7. A short drive shows speed and RPM on the dashboard.

### Rollback

The image saved in step 3 is exactly what ran in the car. It is the first choice:

```bash
pio pkg exec -p tool-esptoolpy -- esptool.py --chip esp32s3 write_flash 0x10000 car-app0-<date>.bin
```

Try the read and the write on the desk AtomS3 first. Its partition table (`default.csv`) has app0 at 0x10000 with a size of 0x140000.

The git tag `fw-known-good-2026-11-11` is the last source before firmware build 2. It may not be byte for byte what the car runs, so use it only when no saved image exists. A rollback from it is: check out the tag, build, flash. There is no older image on disk to fall back on, because every build overwrites `firmware/.pio/build/<env>/firmware.bin`.

```bash
git checkout fw-known-good-2026-11-11
cd firmware
pio run -e sim7670g -t upload
git checkout main
```

Commit your work first, or git carries it into the old checkout. `secrets.h` is not tracked and stays in place. The Worker keeps understanding the old records, so a rollback needs no backend change. Once a firmware has proven itself in the car, tag its source the same way and save its image before flashing a newer one.

### Step 1 checklist (AtomS3 + CX)

1. Unplug the CX for 10 s and plug it back in. It only accepts a new pairing during the first 5 minutes after power-up. Start the engine.
2. Flash `atoms3` and open the monitor. It scans for a device named `OBDLink*`, connects, pairs, and prints the GATT table. Expect `security: encrypted=1 bonded=1`, service `fff0` with `fff1 N` and `fff2 W WnR`, then `notifications enabled`.
3. Init log shows `ATZ -> ELM327 v1.4b`, `STI -> STN2310 ...`, `ATRV`. Adapter setup sends nothing to the car.
4. With the engine running: `[pid] ECU supports: ...`, then one line per second: rpm, speed, temps, MAF, throttle, fuel, volts, instant MPG, trip totals. `--` means no value for that field.
5. Raw console: type `>22xxxx` or `>ATSH7E0` etc. in the monitor to send anything to the adapter. Use this for Mode 22 research. `q` prints the flash queue. `s` prints identity, engine gate and network state. `unpair` erases stored pairings and reboots.

### OBDLink CX notes (learned the hard way)

- The link must be encrypted. Unpaired, the CX accepts writes and silently drops them. Pairing uses passkey 123456 and is only possible for 5 minutes after the CX powers up. The pairing then persists on both sides, so each ESP32 board needs this once.
- Notifications must be enabled with an acknowledged write (`subscribe(true, cb, true)`). NimBLE's default unacknowledged write is ignored.
- The CX distributes an all-zero identity address. If NimBLE stores it (host-based privacy peer record), every later scan reports the CX as `00:00:00:00:00:00` and `deleteAllBonds()` does not clear it. The firmware pairs with encryption keys only and can erase the `nimble_bond` NVS namespace.
- A scan result with a null address is skipped. Only five scans in a row that find nothing but a null-address match trigger the erase-and-reboot path.
- A scan result whose address has a stored pairing wins, then a name starting with `OBDLink`, then a device that only advertises the generic `FFF0` service, and that last one only while nothing is paired. This keeps a stray `FFF0` device from taking a pairing slot. A paired adapter is recognised by its address, also in a scan where its name is missing. The scan log marks it ` [paired]` and the connect line says `(paired address)`.
- The 2024 C8 answers on protocol 7 (CAN 29-bit 500k), not 6. The protocol is fixed to that. With `ATSP0` and the engine off, every request starts a multi-second `SEARCHING...` pass that a 1 Hz poller keeps aborting (`STOPPED`). The automatic search is a fallback and runs at most once per boot, after three unanswered probes in a row at 13.0 V or more, and only when the car has never answered on the stored protocol in this boot. An engine stop after a drive never starts it.

### Design notes

- **Battery guard.** Every cycle starts with `ATRV`, which the adapter answers itself with no CAN traffic. Only RPM above zero proves a running engine. Voltage never does: GM's charging control lets a running engine sit near 12 V, and a charger can hold 13 V with the engine off. Voltage only sets how fast to probe. Active mode polls at 1 Hz and goes quiet after 20 s without RPM above zero.
- **Probe schedule.** While quiet, the only request sent to the car is `010C` (RPM). A probe window opens at connect, on going quiet, and when the adapter voltage rises 0.4 V above the lowest value seen since the window opened. The first probe of a window goes out at once. After that: every 5 s for the first 60 s if the voltage is 13.0 V or more, otherwise every 30 s until the window is 10 minutes old, then every 5 minutes for an hour, then nothing. The quiet tick is 2 s, so the fast probes come about every 6 s. Hard cap of 120 scheduled probes per quiet period. The probe that uses up the 120 is repeated once 30 s later, in case its reply was lost. Past the cap a voltage rise or a reconnect still gets a probe, so a real start is not missed: at most one per 30 s for the first 20 probes past the cap, then at most one per 5 minutes. Each gets the same one repeat 30 s later. A Bluetooth reconnect while the engine is off continues the quiet period. It does not hand out a new probe budget. Its probe goes out at once when the last probe is at least 30 s old (5 minutes once 20 probes past the cap are used), otherwise as soon as it is. Below the cap that probe opens a new window with the same schedule, paid from the same 120. The supported-PID probe (`0100`, `0120`, ...) runs after RPM is seen. The rules live in `include/engine_gate.h`.
- **Parked heartbeat.** Quiet mode stores one record on entering quiet and then one every 30 s. Each one is flushed at once. It carries the adapter voltage, time, GPS and cell signal. Old fuel, odometer and ECU voltage values are not stamped onto it.
- **Queue.** Fixed 48-byte CRC'd records (`include/record.h`) are appended to LittleFS segment files and flushed every 5 records. A segment closes at 341 records, which is one upload body, with or without a network. A new segment starts on every boot, so a torn record can only be the tail of a file. The backend drops it. The upload loop closes the open segment only when no closed one is waiting, so failing uploads do not pile up small files. Nothing is ever truncated. An oversized segment left by older firmware goes out in several uploads and is deleted after the last one. When the filesystem passes 80 percent full, the oldest closed segments are deleted until it is below. A segment whose delete fails during that cleanup is not counted as dropped. It stays queued and is uploaded later. A segment that cannot be read is tried once per upload pass. Its 4th failed read gives it up, and its records are counted as dropped. Failed writes and dropped records are counted (`q` in the console). Worst case on a power cut: about 5 s of readings. What was not uploaded yet goes out on the next drive.
- **Upload.** Raw binary records, oldest first, every 15 s while driving and every 60 s otherwise. A segment is deleted only after a 2xx. The backend ignores a reading it already has, keyed on `(boot, ms)`, so resends are harmless. On HTTP 400 to 599 the wait doubles with every refusal, from 30 s up to 5 minutes, and is back to normal after the next 2xx. A backlog drains at up to 4 uploads per pass, with GNSS and signal read in between. After three refusals in a row of a larger upload the logger falls back to 30-record uploads for the rest of the boot. Uploads of that size are proven on this modem and Worker. The modem start is retried every 30 s until it succeeds. Echo, TLS context, SNI and GNSS power are set again whenever the data link comes back. Each upload is a fresh TLS session, which is most of the data use: roughly 1.5 MB per hour of driving.
- **Identity.** Record byte 44 is an install id: random 1 to 255, drawn once and kept in NVS (namespace `vette`, key `inst`). Byte 45 is the firmware build, `FW_BUILD` in `include/config.h`. This firmware is build 2. Build 0 is firmware from before the byte existed. Raise the number with every flash that changes behavior. The backend numbers a session as boot counter + install id x 65,536 and the dashboard shows it as `<inst>-<counter>`, for example `173-12`. Erasing NVS restarts the boot counter and draws a new id, so old sessions are not overwritten unless the same id comes up again (1 in 255).
- **Time.** Records carry `boot` + `millis`. Epoch comes from GNSS or the cell network clock (`AT+CCLK`) when available. The backend backfills times for records written before the clock was known. A device clock more than 5 minutes ahead is treated as unknown.
- **Speed.** PID requests are sent as `010C1`. The trailing `1` tells the STN to return after the first ECU reply instead of waiting out the timeout. Slow PIDs (fuel, ECU volts, odometer A6) every 10th cycle. The ECU's supported-PID bitmasks decide what gets asked. A supported PID that returns NO DATA 3 times in a row is skipped, and asked again once a minute while the logger polls. Nothing is asked for it while quiet. A PID the car never answers costs at most 3 requests a minute. RPM (`0C`) is never skipped and is asked even when the supported-PID mask leaves it out. When two cycles in a row get no RPM reply, nothing else is asked until RPM answers again. One lost RPM reply on a running engine still gets speed, airflow, throttle and temperatures.
- **MPG** = speed / (MAF x 3600 / (14.1 x 2798.7 g/gal)). 14.1 is the air-fuel ratio for E10 pump fuel (14.7 is pure gasoline). The firmware (`AFR_STOICH`) and the backend (`AFR` in `src/queries.ts`) use the same value. Airflow-based fuel reads low at full throttle and high while coasting, so every fuel and MPG figure is an estimate.

### sim7670g board notes

- DIP switches: `4G` on (powers the modem, no power-key pulse needed), `HUB` on (needed for USB flashing and serial), `CAM` off, `USB` off (keeps the modem's own USB off the cable so the computer sees one serial port).
- LTE needs the external antenna on the LTE connector. GPS needs the external antenna on the GNSS connector and a view of the sky.
- First boot needs the CX pairing window again: replug the CX, and keep any other paired board unpowered so it does not take the connection.
- Modem UART: ESP32 RX 17, TX 18, 115200.
- APN `america.bics` is confirmed for this SIM family (EIOTCLUB). It is `MODEM_APN` in `secrets.h`. The boot log prints `ATI` and the ICCID.
- On this modem the `AT+CCLK` clock is already UTC, and GNSS positions arrive as decimal degrees, not NMEA. The firmware handles both.
- HTTPS uses the modem's own HTTP stack (`AT+HTTPINIT/HTTPPARA/HTTPDATA/HTTPACTION`) with TLS context 0 and SNI on. A code of 700 or more from `HTTPACTION` is a modem-side network or TLS error. The firmware then rechecks registration.
- The TLS context skips server certificate checks (`authmode 0`), like the WiFi path. There is no pinning: without remote updates, a certificate change at Cloudflare would strand the logger until a reflash.
- Serial logs go out UART0 via the onboard CH343 (`ARDUINO_USB_CDC_ON_BOOT=0`). If the monitor is silent, flip it to 1.
- Nothing here tracks the SIM plan. A lapsed plan looks exactly like a parked car.

### Not verified on the road

- Firmware build 2 as a whole. Nothing of it has run on a board yet. The bench build compiles but has not run on the AtomS3. That covers the probe schedule, the parked heartbeat, the queue through a dead zone and the drain afterwards, the upload backoff, the fallback to 30-record uploads, the modem retry and the once-a-minute retry of skipped PIDs.
- Adapter matching by paired address (`NimBLEDevice::isBonded` against the CX's advertised address).
- The probe a Bluetooth reconnect is owed, with real link drops at crank.
- Whether a C8 ECU that answers NO DATA at the start of a drive answers within the first minute.
- Unreadable and undeletable queue segments on real flash. They are tested only against a fake filesystem.
- A full 341-record backlog from the car. A synthetic 341-record upload to the live Worker was stored in one D1 batch in about 0.3 s on the Free plan (2026-11-12). The largest upload from the car so far was 31 records.
- Adapter voltage with ignition on and engine off, and just after a start. The 13.0 V and 0.4 V thresholds rest on it.
- Behavior on a battery charger.
- MPG against a real fill-up. The fuel constant is not calibrated. Logged distance was 0.7 to 1.2 percent below the odometer on three drives.

### Not done

- GM Mode 22 data (oil life, trans fluid and filter life). The codes need research. The `>` console is the tool for it.
- Over-the-air updates. Every firmware change is a laptop trip to the car.
- Link-down records. The backend understands the no-link flag (`F_NO_LINK`), but firmware build 2 does not write such records. With no Bluetooth link to the CX, nothing is stored.
- Alerts, a login system, TLS pinning, SIM plan tracking.

## Backend

```bash
cd backend
npm install
npx wrangler login
npm run setup
```

`npm run setup` finds or creates the D1 database, loads `schema.sql`, checks that no schema change is missing, deploys the Worker, generates `DEVICE_TOKEN`, `MCP_SECRET` and `DASH_SECRET` once and stores them as Worker secrets, fills `INGEST_HOST` and `DEVICE_TOKEN` into `firmware/include/secrets.h`, writes the connector URL to `backend/.secrets/connector-url.txt` and the dashboard URL to `backend/.secrets/dashboard-url.txt`, and checks the live Worker. It is safe to re-run on a machine that holds `backend/.secrets/deploy.json`. When a wrangler step fails, setup prints only the cause, with the database id, account ids and login email masked. It never prints the D1 database list. Later code changes: `npm run deploy`.

On a brand-new Cloudflare account the first run stops at the deploy. Open the link wrangler prints, pick a workers.dev subdomain, then run `npm run setup` again. Nothing is lost.

These files exist only on your machine (gitignored): `backend/.secrets/`, `backend/wrangler.local.toml`, `backend/.dev.vars`, `firmware/include/secrets.h`. Keep a copy of `backend/.secrets/deploy.json` somewhere safe. It holds the three secrets.

`node scripts/setup.mjs --dry-run` runs only the local file steps with a fake URL and writes into a temp folder. It refuses to run on a checkout that is already set up.

### Deploying

`npm run deploy` runs `scripts/deploy.mjs`. It does four things:

1. It runs `npm run typecheck`, `npm test` and `npm run check:dash`, and stops before anything remote when one of them fails. `npm run deploy -- --skip-checks` leaves them out. Every other argument still goes to wrangler.
2. It rebuilds `wrangler.local.toml` from `wrangler.toml` and keeps the real database id the old copy holds. An edit of `wrangler.toml` (for example `LOCAL_TZ`, the zone used for times and day boundaries) goes live with the next deploy.
3. It reads the columns of the remote database and refuses to deploy when a schema change is missing. The message names the missing columns and gives the command to run.
4. It runs `wrangler deploy --config wrangler.local.toml`.

The columns it asks for are `REQUIRED_COLUMNS` in `scripts/deploy.mjs`. Add to that list with every new file in `schema-changes/`. `npm run setup` deploys through the same code from step 3 on, so it stops the same way on a missing schema change. It does not run the checks of step 1. The database id is not printed. In wrangler's output ids show as `<id>` and email addresses as `<email>`.

State on 2026-11-12: schema change 0001 is applied to the live database and the Worker is deployed. A synthetic 341-record upload was stored in one D1 batch in about 0.3 s on the Free plan. Every API endpoint and all six Claude tools answered. The three leftover backup tables of 2026-11-11 were dropped after an export. The car still runs the old firmware (build 0).

### Second machine

Copy `backend/.secrets/deploy.json` from the first machine into the same place, pull the latest code, then run the four commands above. Setup reuses the stored secrets and deploys the checkout it runs from.

Without that file setup stops as soon as it sees that the database already exists, before it changes anything. New secrets would replace the live ones: the car would be locked out until a reflash, and both private links would change.

A `deploy.json` that does not belong to the live Worker (a leftover from a test, or an old copy) is caught as well. After the deploy and before any secret is stored, setup tries one stored secret on the live Worker and stops when it is refused.

`npm run setup -- --new-secrets` overrides both stops when that is what you want. It does not rotate anything by itself: when `deploy.json` holds all three secrets and the live Worker uses them, it stops and says so.

### Rotating a secret

Delete its key from `backend/.secrets/deploy.json` and run `npm run setup`. A new value is generated and is live on the Worker at once. Setup also deploys the code of this checkout, so run it from the commit that is live. What else must then change:

- `DEVICE_TOKEN`: setup rewrites `secrets.h`. Flash the board. Until then the car's uploads are refused and the logger keeps its data in the flash queue.
- `MCP_SECRET`: replace the custom connector in Claude with the new URL from `connector-url.txt`.
- `DASH_SECRET`: open the new link from `dashboard-url.txt`. Old bookmarks and home screen icons stop working.

### Local test without hardware

```bash
npm run db:init:local
npm run dev
node scripts/fake-device.mjs            # simulated drive, uploaded like the logger would
node scripts/mcp-smoke.mjs              # calls the MCP tools
```

`wrangler dev` reads its secrets from `backend/.dev.vars` (gitignored). Nothing creates that file. Make it once with these three lines:

```
DEVICE_TOKEN=dev-device-token
MCP_SECRET=dev-mcp-secret
DASH_SECRET=dev-dash-secret
```

The two scripts default to these values, and the local dashboard is then `http://127.0.0.1:8787/dash/dev-dash-secret/`. Without the file every upload gets 401 and the other two paths 404.

`db:init:local` only creates what is missing. A local database from before schema change 0001 answers 503 until you run the local command from the header of `schema-changes/0001-trips-odometer-fw.sql`. Deleting `backend/.wrangler/state` and starting over works too.

### Tests

```bash
npm test             # scripts/run-tests.mjs
npm run typecheck
npm run check:dash   # scripts/check-dash.mjs
```

- `npm test` bundles every `test/*.test.mjs` with the esbuild that wrangler installed and runs them with `node --test`. The database is a D1 look-alike on `node:sqlite` (`test/helpers/d1.mjs`). No network and no Cloudflare login.
- Covered: the record decoder against the golden record, a flipped byte and a torn tail, the ingest rules below, one drive posted at once or in pieces giving the same rollups, the rebuild script and schema change 0001, the car state rule, local-day handling across clock changes, every Claude tool, the secret paths of the dashboard and connector, and the page headers.
- The look-alike counts rows returned, not rows scanned. It says nothing about the real D1 cost of a query.
- `npm run check:dash` runs `node --check` on the inline script of `src/dash.html`, then runs the page script in a stand-in browser against the real dashboard API on the test database. It opens all five views through their nav buttons and a trip from the list, on a desktop and on a touch phone width, and redraws the charts of each view for a new window width. It clicks every History preset and metric button, brings the page back from the background after 2 and after 7 minutes, and ends the 15-minute pause with a tap. It opens a page older than the deployed one, a page whose drawing throws during a poll, and a live answer with a series the page does not know. It fails when the page uses an element id that is not in the markup, or when a page is left with two polls on the way. The clock is pinned and the zone is America/Los_Angeles, so the result does not depend on the machine or the hour. Nothing else runs that script before a browser does. Layout still needs a real browser.
- `npm run deploy` runs all three and deploys nothing when one fails.

### Ingest rules

- One upload is one `DB.batch`, which D1 runs as one transaction. It lands completely or not at all.
- A reading that is already stored is ignored, not rewritten.
- A body over 65,536 bytes gets 413. A record with a good CRC but an unknown version gets 422 and nothing is stored. Any failure gets 503. The logger keeps its data on every non-2xx and sends it again.
- The decoder resynchronises after damaged bytes. Where no intact record starts, it searches byte by byte for the next one, so a torn or odd-sized piece in the middle does not cost the records behind it. Each damaged stretch counts once in `rejected`. Rarely, about once in 65,536 torn pieces, a torn piece and the next record pass the CRC together by chance. One mixed record is then stored and the next one is lost.
- Two uploads of the same session can overlap when the logger resends after a timeout. When one of them is stored while the Worker is still busy with the other, the slower one gets 503, even when it holds only records that are already stored. The logger then sends it again. This keeps the latest values from going back to older ones.
- The `latest` row is a cache of the newest values. Entries in it that are not whole are dropped and filled again by the next records. A damaged row no longer blocks uploads.
- One missed RPM reply no longer shows a driving car as parked. A record without RPM still counts as engine on for 5 s after the last RPM above zero of the same session.
- Worker logs are kept (`[observability]` in `wrangler.toml`). Failures are logged with `console.error`. Read them in the Cloudflare dashboard.

### Schema changes

`schema.sql` is the full current schema. Setup loads it, and a new database needs nothing else. It only creates what is missing, so it never alters a table that already exists.

A change to an existing database is one numbered file in `backend/schema-changes/`, run by hand once, before deploying code that needs it. The files are not idempotent. Each header has the exact command. Three steps, one at a time, while the car is parked:

1. `npm run db:backup`. Go on only if it ends with `Done`.
2. Run the file:

   ```bash
   npx wrangler d1 execute vette --remote --config wrangler.local.toml --file=schema-changes/0001-trips-odometer-fw.sql
   ```

3. `npm run deploy`.

Do not paste the three as one block. A shell runs the later lines even when the backup failed.

`0001-trips-odometer-fw.sql` adds `odo_start`, `odo_end`, `fw` and `nolink_n` to `trips` and fills the odometer columns from `samples`. A Worker that needs these columns would answer 503 on every upload without them. That is why `npm run deploy` and `npm run setup` check for them first and refuse to deploy when they are missing.

### Rebuilding the rollups

`backend/maintenance/rebuild-rollups.sql` rebuilds `trips`, `minutes` and `track` from `samples`. Rows left over from before a repair do not survive it. Run it after repairing readings by hand, while the car is parked. The command is in its header. It is safe to run again. Readings do not store the firmware build, so it is kept from the old trip row.

Rows read: about 3 per reading. Rows written depend on the kind of reading, because every minute and route row is deleted and written again, and D1 counts index entries too. About 0.3 per reading while driving at 1 Hz. About 5 per parked heartbeat with a GPS fix: build 2 stores one every 30 s while parked, and each becomes a route point. About 1 per heartbeat without a fix. A parked day with a fix costs about 14,000.

D1 Free allows 100,000 rows written per day. Count before a remote run. This reads each rollup row once:

```bash
npx wrangler d1 execute vette --remote --config wrangler.local.toml --command "SELECT (SELECT COUNT(*) FROM track) * 4 + (SELECT COUNT(*) FROM minutes) * 2 + (SELECT COUNT(*) FROM trips) * 4 AS writes"
```

Run the file in one go only when `writes` is under about 90,000. Writes the uploads made earlier that UTC day count too. The remote run is one unit. As written it cannot run in parts or be continued the next day, and the database answers nothing while it runs. A run that uses up the daily writes leaves every upload answering 503 until 00:00 UTC.

Past that size do not run the file as it is. Rebuild one range of sessions per UTC day with the `WHERE boot BETWEEN` edit described in its header, and count the range first as the header says. Or move the account to the Workers Paid plan for the rebuild.

### Backups

`npm run db:backup` saves the remote database into `backend/.secrets/backups/` (gitignored). It ends with `Done` only when a backup exists. What it produces depends on the Cloudflare login:

- With the export permission: one file `vette-<UTC timestamp>.sql` with schema and data, from `wrangler d1 export`. The current login has it (checked 2026-11-12).
- Without it: a login can be allowed to run queries and still be refused the export (`Authentication error [code: 10000]`). The script then reads every table through read-only queries into a folder `vette-<UTC timestamp>/`: `schema.sql` and one `<table>.json` per table, each checked against the row count of its table. Running `npx wrangler login` again restores the single-file export.

The folder form has no one-command restore. `schema.sql` recreates the tables and the rows are plain JSON. Each table is read in pages of 5,000 rows in key order, and each page starts after the last row of the one before. The cost is about 2 rows read per stored row, one for the row count and one for the read. The script stops before reading anything when the cost would pass 3,000,000 rows, which leaves 2,000,000 of the daily 5,000,000 for the Worker. That is about 1,500,000 stored rows, roughly 360 hours of driving. A reading uploaded while the backup runs is left for the next backup. A deleted row stops the backup with `changed while it was read`. Run it while the car is parked. The folder form has not been run against the live database since it moved to key order.

Only table names and row counts are printed. Either form holds every reading and position, so treat it like the secrets. Take one before any schema change or hand repair.

### Database cost (D1 Free)

D1 Free allows 5,000,000 rows read and 100,000 rows written per day, and 500 MB per database. D1 counts every row a query scans. A spent quota blocks reads and writes until 00:00 UTC, so a page that reads too much can stop uploads from being stored.

Raw readings live in `samples` (one per second while driving), but nothing that refreshes reads them in bulk. Each upload folds its readings into three rollups (`src/rollup.ts`): `trips` (one row per session), `minutes` (per-minute aggregates) and `track` (a GPS point every 15 s). The dashboard and Claude tools read those, so a 30-day trips lookup reads a handful of rows instead of thousands. Raw readings are only read for one trip's detail or CSV, the newest readings in Logs, live updates newer than what the page already has, and History windows of an hour or less.

Every `/api/*` answer of the dashboard carries `X-Rows-Read`, the rows D1 reported for that request, and `X-Page`, the id of the page that is deployed. The id costs no rows.

### Dashboard

Open the URL in `backend/.secrets/dashboard-url.txt` on any device: `https://<worker-host>/dash/<DASH_SECRET>/`. The secret path is the auth, so treat the URL like a password. On a phone, "Add to Home Screen" makes it behave like an app.

Five views. **Overview**: fuel, range, battery, 30-day MPG, last drive's speed, per-trip MPG against EPA, location, recent trips. **Live**: speed, RPM, throttle, coolant, instant MPG, airflow, battery, intake air, fuel and cell signal with the last 10 minutes as sparklines and charts. With the engine off the gauges are grey, and a value from an earlier session shows its age. **Trips**: every trip with a speed-colored route, stats, charts and CSV export. **History**: any date or time range, with totals, charts, routes and the trips in it. **Logs**: last upload, uploads per hour, signal, GPS with the age of the last fix, the upload log, the newest raw readings (with a fix tag, not coordinates) and a per-session summary with firmware build.

- The header shows running, no signal or parked, from a rule shared with the Claude tools (`STATE_RULES` in `src/queries.ts`). Engine flag on and newest record under 90 s old: running. 90 s to 10 minutes: no signal. Older: parked, marked as ended mid-drive. Engine flag off: parked. No record at all: unknown.
- The Location card says `Last fix` with a grey marker when the newest readings came without a GPS fix. While driving that takes a minute without one. A parked car needs 10 minutes, or a fix from an earlier session, because a garage often blocks the fix before the engine stops. After a drive whose end never arrived it says `Last known`.
- Range uses the 30-day MPG once at least 25 miles are logged in that window. Before that it uses the EPA combined figure (19), and the Estimated range card says `at EPA 19 mpg, too few miles logged yet`. With enough miles but no fuel readings it says `at EPA 19 mpg, no fuel use readings`, like the Fuel economy card. The 30-day miles are shown rounded down to one decimal (24.96 shows as 24.9), so they never show 25.0 while the 30-day MPG is still missing.
- Polling: every 15 s on Live while driving, slower on the other views and when parked. It stops while the tab is hidden and pauses after 15 minutes without interaction. If the trip list or the fuel economy figures fail to load while the server is answering, the page asks for them once more on the next poll, then on every sixth poll. A failure during a full outage does not count, so both load on the first poll after the connection returns. An error while drawing an answer does not stop the polling.
- A page left open across a deploy notices it. Back from the background it reloads itself. Until then the header says `new version, tap to reload` next to the car state, with a Reload button. The Logs footer ends with the id of the page that is running (`Page <id>.`), so a deploy can be seen to have arrived on the phone.
- Trips show odometer distance next to logged distance, and the unlogged miles between two trips when the odometer shows a gap.
- A trip that logged under 0.1 mi but whose GPS route moved shows its distance along the route instead, marked "by GPS". This covers drives where the speed readings failed. Route points are 15 s apart, so it reads a little short on curves. Steps under 2 m/s (drift while standing), over 70 m/s or more than 60 s apart do not count. Fuel and MPG stay empty for such a trip, and totals and the 30-day MPG use logged distance only. The Claude trip tools add `gps_distance_mi` with a note in the same case, and `get_history` adds it to its trip rows.
- Fuel level readings of 0 % are left out of the History fuel figures and never become the newest fuel level. One bad reply to the fuel level request reads as 0 %, and the firmware carries it into about ten records. The raw readings keep it.
- The page is `backend/src/dash.html` (no build step) and its JSON API is in `backend/src/dash.ts`. Map tiles come from OpenStreetMap and Leaflet from unpkg. The page sends `Referrer-Policy: strict-origin`, so those hosts see the Worker's hostname and never the secret path. `no-referrer` would hide the hostname too, but the tile servers refuse requests without a referrer.

### Claude connector

Settings > Connectors > Add custom connector, URL `https://<worker-host>/mcp/<MCP_SECRET>` (it is in `backend/.secrets/connector-url.txt`). The secret path is the auth, so treat the URL like a password.

All tools are read-only. Answers are compact JSON. A tool that takes a trip id accepts the full number (`11337740`) or the label the dashboard shows (`173-12`). Some clients never show the instructions text to the model, so each tool description repeats what it needs: the car, what a trip is, that fuel figures are estimates, and that the position is given only when the user asks.

- `get_latest_status`: car state (running, no signal, parked or unknown) with one plain sentence, fuel and range, battery with a context word, temperatures, odometer, cell signal (also in dBm), and the logger's firmware build, adapter link and last upload. No coordinates, and the description says so. While the logger uploads stored records after a gap, the sentence says so, and that the current state is not known until it has caught up. Each engine value is dated by its own record. One that stopped arriving (another session, or more than 120 s behind the newest) is null and listed with its age in `engine_values_stale`. `odometer_as_of` appears when the odometer reading lags the last report by more than 10 minutes, and `battery_note` when the voltage is more than 10 minutes old. Range uses the 30-day MPG from 25 logged miles. Under that it uses a rough MPG of the logged miles (from 5 miles on) when that is below the EPA figure, and EPA 19 otherwise. `range_basis` says which.
- `get_location`: last GPS position with a map link and its age. The description tells Claude to call it only when the user asks where the car is. `fix_before_last_report_min` says how much older the fix is than the last report. `parked` is null when that is not known: adapter link down, stored records still uploading, or the last report still had the engine on. Apart from `get_trip_summary` with `include_locations: true`, the only tool that returns coordinates.
- `get_trip_summary`: one trip. By default the newest in which the car moved (0.1 mi logged, or a GPS distance) or the one in progress. Newer sessions without driving are listed in `newer_sessions_without_driving`. Logger-on, engine-on and moving time, logged and odometer distance, unlogged miles before it, estimated fuel and MPG, and the tank gauge near the start and end from the per-minute rows. No fuel figure comes from the gauge, which swings by several points within a drive. `include_locations: true` adds start and end coordinates.
- `list_trips`: recent trips, with `limit` and optional `from` and `to` dates (`YYYY-MM-DD`, local zone, inclusive).
- `get_fuel_economy`: combined MPG estimate over a number of days, against EPA, with best and worst from trips of 2 miles or more. `combined_mpg_few_miles` is true when the estimate rests on fewer than 25 logged miles in the window. The figure is still returned, but it is rough and the note says so.
- `get_history`: totals for a `period` (today, yesterday, last_7_days, last_30_days, this_month, last_month, this_year) or for `from` and `to` dates, with optional `group_by: "day"`. It reads only the rollups. The window is capped at 366 days. Next to the logged `distance_mi` it gives `odometer_distance_mi`, how far the odometer moved over the trips wholly inside the window, and the note says how much of that was logged when the two differ. When `unlogged_mi` is not known, `unlogged_mi_at_least` adds up the gaps that are. `mpg_est_few_miles` marks an MPG from fewer than 25 logged miles.

A trip is one session (one power-up of the logger) in which the engine ran. When the logger stopped sending while the engine was on, `list_trips` and `get_trip_summary` mark that trip `end_not_received`: its end, distance and fuel may still arrive after the next start.
