// Simulates a drive and uploads it like the ESP32 would. Encodes the same 48-byte Record.
// Usage: node scripts/fake-device.mjs [baseUrl] [token] [boot] [daysAgo]
const base = process.argv[2] ?? "http://127.0.0.1:8787";
const token = process.argv[3] ?? "dev-device-token";
const boot = Number(process.argv[4] ?? 1);
const daysAgo = Number(process.argv[5] ?? 0);

function crc16(b, n) {
  let c = 0xffff;
  for (let i = 0; i < n; i++) {
    c ^= b[i] << 8;
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  }
  return c;
}

function encode(r) {
  const buf = new ArrayBuffer(48);
  const d = new DataView(buf);
  const b = new Uint8Array(buf);
  b[0] = 0xc8; b[1] = 1;
  d.setUint16(2, r.boot, true);
  d.setUint32(4, r.ms, true);
  d.setUint32(8, r.epoch, true);
  d.setInt32(12, Math.round(r.lat * 1e7), true);
  d.setInt32(16, Math.round(r.lon * 1e7), true);
  d.setUint16(20, r.rpm, true);
  d.setUint16(22, Math.round(r.maf * 100), true);
  d.setUint16(24, Math.round(r.volts * 1000), true);
  d.setInt16(26, Math.round(r.coolant * 10), true);
  d.setInt16(28, Math.round(r.iat * 10), true);
  b[30] = r.kph; b[31] = r.thr; b[32] = Math.round(r.fuel * 2.55); b[33] = 20;
  d.setUint16(34, 0x0fff & ~(1 << 8), true); // everything valid except odometer
  d.setUint16(40, Math.round((r.volts - 0.2) * 1000), true);
  b[42] = 9; b[43] = r.engineOn ? 1 : 0;
  d.setUint16(46, crc16(b, 46), true);
  return b;
}

// 20 minute drive starting 25 minutes ago. Clock unknown for the first 60 s (no GNSS/NITZ yet).
const start = Math.floor(Date.now() / 1000) - 25 * 60 - Math.round(daysAgo * 86400);
const recs = [];
// Vary the start point per session so multi-day tests draw separate routes.
let lat = 37.7749 + (boot % 5) * 0.03, lon = -122.4194 + (boot % 3) * 0.04, fuel = 62 - daysAgo;
for (let s = 0; s < 20 * 60; s++) {
  const phase = s / 60;
  const kph = s < 30 ? 0 : Math.round(Math.max(0, 70 + 40 * Math.sin(phase / 2) + (Math.random() - 0.5) * 10));
  const rpm = kph === 0 ? 750 : 1200 + kph * 18;
  const maf = kph === 0 ? 4.5 : 3 + kph * 0.12 + Math.random() * 2;
  lat += (kph / 3600) * 0.009 * 0.7; lon += (kph / 3600) * 0.009 * 0.7;
  fuel -= 0.0012;
  recs.push(encode({
    boot, ms: 2000 + s * 1000, epoch: s < 60 ? 0 : start + s + 2,
    lat, lon, rpm, maf, volts: 14.2, coolant: Math.min(95, 40 + s / 4), iat: 25,
    kph, thr: Math.min(100, Math.round(kph / 2)), fuel, engineOn: true,
  }));
}

async function post(chunk) {
  const body = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk.length * 48);
  if (!(chunk instanceof Uint8Array)) chunk.forEach((r, i) => body.set(r, i * 48));
  const res = await fetch(`${base}/ingest`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
    body,
  });
  console.log(res.status, await res.text());
}

// First 40 records alone (no epoch yet, so times get estimated, then corrected).
await post(recs.slice(0, 40));
for (let i = 40; i < recs.length; i += 300) await post(recs.slice(i, i + 300));
// A torn tail like a power cut would leave.
const torn = new Uint8Array(48 + 20);
torn.set(recs[recs.length - 1]);
await post(torn);
