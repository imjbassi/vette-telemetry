// Encoder for the 48-byte firmware Record. The layout lives in firmware/include/record.h and
// the decoder in src/record.ts. This is the only encoder on the backend side: the fake device
// and the tests both use it, and a test pins it to the golden record in the change contract.
export const REC_SIZE = 48;
export const REC_MAGIC = 0xc8;
export const REC_VERSION = 1;
// The firmware never puts more records in one request (MAX_UPLOAD_BYTES / 48).
export const MAX_UPLOAD_RECORDS = 341;

export const V = {
  RPM: 1 << 0, SPEED: 1 << 1, COOLANT: 1 << 2, INTAKE: 1 << 3, MAF: 1 << 4, THROTTLE: 1 << 5,
  FUEL: 1 << 6, ECU_V: 1 << 7, ODO: 1 << 8, ADAPTER_V: 1 << 9, GPS: 1 << 10, CSQ: 1 << 11,
};
export const F = { ENGINE_ON: 1 << 0, QUIET: 1 << 1, NO_LINK: 1 << 2 };

// CRC-16/CCITT-FALSE.
export function crc16(b, n) {
  let c = 0xffff;
  for (let i = 0; i < n; i++) {
    c ^= b[i] << 8;
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  }
  return c;
}

// One record as a Uint8Array(48). Values are in the units the decoder gives back:
//   boot (the board's 16-bit counter), inst, fw, ms, epoch, flags,
//   lat, lon, sats, rpm, maf_gs, adapter_v, coolant_c, intake_c, speed_kph, throttle_pct,
//   fuel_pct (or fuel_raw 0..255, which wins), csq, odo_km, ecu_v.
// A measurement that is left out or null is written as zero with its valid bit clear, like a
// PID the car did not answer. lat and lon only count together. `valid`, `version`, `magic`
// and `crc` override what would be computed, for tests that need a damaged or foreign record.
export function encodeRecord(r) {
  const buf = new ArrayBuffer(REC_SIZE);
  const d = new DataView(buf);
  const b = new Uint8Array(buf);
  const has = (x) => x !== undefined && x !== null;
  let valid = 0;

  b[0] = r.magic ?? REC_MAGIC;
  b[1] = r.version ?? REC_VERSION;
  d.setUint16(2, r.boot ?? 1, true);
  d.setUint32(4, r.ms ?? 0, true);
  d.setUint32(8, r.epoch ?? 0, true);
  if (has(r.lat) && has(r.lon)) {
    d.setInt32(12, Math.round(r.lat * 1e7), true);
    d.setInt32(16, Math.round(r.lon * 1e7), true);
    b[42] = r.sats ?? 0;
    valid |= V.GPS;
  }
  if (has(r.rpm)) { d.setUint16(20, r.rpm, true); valid |= V.RPM; }
  if (has(r.maf_gs)) { d.setUint16(22, Math.round(r.maf_gs * 100), true); valid |= V.MAF; }
  if (has(r.adapter_v)) { d.setUint16(24, Math.round(r.adapter_v * 1000), true); valid |= V.ADAPTER_V; }
  if (has(r.coolant_c)) { d.setInt16(26, Math.round(r.coolant_c * 10), true); valid |= V.COOLANT; }
  if (has(r.intake_c)) { d.setInt16(28, Math.round(r.intake_c * 10), true); valid |= V.INTAKE; }
  if (has(r.speed_kph)) { b[30] = r.speed_kph; valid |= V.SPEED; }
  if (has(r.throttle_pct)) { b[31] = r.throttle_pct; valid |= V.THROTTLE; }
  if (has(r.fuel_raw)) { b[32] = r.fuel_raw; valid |= V.FUEL; }
  else if (has(r.fuel_pct)) { b[32] = Math.round(r.fuel_pct * 2.55); valid |= V.FUEL; }
  if (has(r.csq)) { b[33] = r.csq; valid |= V.CSQ; }
  if (has(r.odo_km)) { d.setUint32(36, Math.round(r.odo_km * 10), true); valid |= V.ODO; }
  if (has(r.ecu_v)) { d.setUint16(40, Math.round(r.ecu_v * 1000), true); valid |= V.ECU_V; }
  d.setUint16(34, r.valid ?? valid, true);
  b[43] = r.flags ?? 0;
  b[44] = r.inst ?? 0;
  b[45] = r.fw ?? 0;
  d.setUint16(46, r.crc ?? crc16(b, 46), true);
  return b;
}

// Records (as returned by encodeRecord) back to back, as one upload body.
export function joinRecords(records) {
  const body = new Uint8Array(records.reduce((n, r) => n + r.length, 0));
  let off = 0;
  for (const r of records) { body.set(r, off); off += r.length; }
  return body;
}
