// Simulates a drive and uploads it like the ESP32 would. Encodes the same 48-byte Record.
// Usage: node scripts/fake-device.mjs [baseUrl] [token] [boot] [daysAgo] [inst] [fw] [odoKm]
//   inst   install id byte, 0..255. Default 0, a board with legacy firmware. The Worker's
//          session id is boot + inst * 65536.
//   fw     firmware build byte, 0..255. Default 0, legacy firmware.
//   odoKm  odometer at the start of the drive. Left out: no odometer, as before.
import { encodeRecord, F, joinRecords, MAX_UPLOAD_RECORDS, REC_SIZE } from "./lib/record-encode.mjs";

const base = process.argv[2] ?? "http://127.0.0.1:8787";
const token = process.argv[3] ?? "dev-device-token";
const boot = Number(process.argv[4] ?? 1);
const daysAgo = Number(process.argv[5] ?? 0);
const inst = Number(process.argv[6] ?? 0);
const fw = Number(process.argv[7] ?? 0);
const odoStart = process.argv[8] == null ? null : Number(process.argv[8]);

// 20 minute drive starting 25 minutes ago. Clock unknown for the first 60 s (no GNSS/NITZ yet).
const start = Math.floor(Date.now() / 1000) - 25 * 60 - Math.round(daysAgo * 86400);
const recs = [];
// Vary the start point per session so multi-day tests draw separate routes.
let lat = 37.7749 + (boot % 5) * 0.03, lon = -122.4194 + (boot % 3) * 0.04, fuel = 62 - daysAgo;
let km = 0;
for (let s = 0; s < 20 * 60; s++) {
  const phase = s / 60;
  const kph = s < 30 ? 0 : Math.round(Math.max(0, 70 + 40 * Math.sin(phase / 2) + (Math.random() - 0.5) * 10));
  const rpm = kph === 0 ? 750 : 1200 + kph * 18;
  const maf = kph === 0 ? 4.5 : 3 + kph * 0.12 + Math.random() * 2;
  lat += (kph / 3600) * 0.009 * 0.7; lon += (kph / 3600) * 0.009 * 0.7;
  fuel -= 0.0012;
  km += kph / 3600;
  recs.push(encodeRecord({
    boot, inst, fw, ms: 2000 + s * 1000, epoch: s < 60 ? 0 : start + s + 2,
    lat, lon, sats: 9, rpm, maf_gs: maf, adapter_v: 14.2, ecu_v: 14.0, coolant_c: Math.min(95, 40 + s / 4), intake_c: 25,
    speed_kph: kph, throttle_pct: Math.min(100, Math.round(kph / 2)), fuel_pct: fuel, csq: 20,
    odo_km: odoStart == null ? null : odoStart + km, flags: F.ENGINE_ON,
  }));
}

async function postBytes(body) {
  const res = await fetch(`${base}/ingest`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
    body,
  });
  console.log(res.status, await res.text());
}

// Like the firmware, never more than one full segment per request.
async function post(records) {
  for (let i = 0; i < records.length; i += MAX_UPLOAD_RECORDS) {
    await postBytes(joinRecords(records.slice(i, i + MAX_UPLOAD_RECORDS)));
  }
}

// First 40 records alone (no epoch yet, so times get estimated, then corrected).
await post(recs.slice(0, 40));
for (let i = 40; i < recs.length; i += 300) await post(recs.slice(i, i + 300));
// A torn tail like a power cut would leave.
const torn = new Uint8Array(REC_SIZE + 20);
torn.set(recs[recs.length - 1]);
await postBytes(torn);
