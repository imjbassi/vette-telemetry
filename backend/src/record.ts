// Decoder for the 48-byte firmware Record. Mirror of firmware/include/record.h.
export const REC_SIZE = 48;
const REC_MAGIC = 0xc8;
const REC_VERSION = 1;

export const V = {
  RPM: 1 << 0, SPEED: 1 << 1, COOLANT: 1 << 2, INTAKE: 1 << 3, MAF: 1 << 4, THROTTLE: 1 << 5,
  FUEL: 1 << 6, ECU_V: 1 << 7, ODO: 1 << 8, ADAPTER_V: 1 << 9, GPS: 1 << 10, CSQ: 1 << 11,
} as const;

export const F = { ENGINE_ON: 1 << 0, QUIET: 1 << 1 } as const;

export interface Sample {
  boot: number;
  ms: number;
  epoch: number; // 0 if unknown
  lat: number | null;
  lon: number | null;
  sats: number | null;
  rpm: number | null;
  speed_kph: number | null;
  coolant_c: number | null;
  intake_c: number | null;
  maf_gs: number | null;
  throttle_pct: number | null;
  fuel_pct: number | null;
  adapter_v: number | null;
  ecu_v: number | null;
  odo_km: number | null;
  csq: number | null;
  flags: number;
}

export function crc16(b: Uint8Array, n: number): number {
  let c = 0xffff;
  for (let i = 0; i < n; i++) {
    c ^= b[i] << 8;
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  }
  return c;
}

export function decode(buf: ArrayBuffer): { samples: Sample[]; rejected: number } {
  const samples: Sample[] = [];
  let rejected = 0;
  const whole = Math.floor(buf.byteLength / REC_SIZE);
  if (buf.byteLength % REC_SIZE) rejected++; // torn tail from a power cut
  for (let i = 0; i < whole; i++) {
    const off = i * REC_SIZE;
    const b = new Uint8Array(buf, off, REC_SIZE);
    const d = new DataView(buf, off, REC_SIZE);
    if (b[0] !== REC_MAGIC || b[1] !== REC_VERSION || crc16(b, 46) !== d.getUint16(46, true)) {
      rejected++;
      continue;
    }
    const valid = d.getUint16(34, true);
    const has = (bit: number) => (valid & bit) !== 0;
    samples.push({
      boot: d.getUint16(2, true),
      ms: d.getUint32(4, true),
      epoch: d.getUint32(8, true),
      lat: has(V.GPS) ? d.getInt32(12, true) / 1e7 : null,
      lon: has(V.GPS) ? d.getInt32(16, true) / 1e7 : null,
      sats: has(V.GPS) ? b[42] : null,
      rpm: has(V.RPM) ? d.getUint16(20, true) : null,
      maf_gs: has(V.MAF) ? d.getUint16(22, true) / 100 : null,
      adapter_v: has(V.ADAPTER_V) ? d.getUint16(24, true) / 1000 : null,
      coolant_c: has(V.COOLANT) ? d.getInt16(26, true) / 10 : null,
      intake_c: has(V.INTAKE) ? d.getInt16(28, true) / 10 : null,
      speed_kph: has(V.SPEED) ? b[30] : null,
      throttle_pct: has(V.THROTTLE) ? b[31] : null,
      fuel_pct: has(V.FUEL) ? Math.round((b[32] * 1000) / 255) / 10 : null,
      csq: has(V.CSQ) ? b[33] : null,
      odo_km: has(V.ODO) ? d.getUint32(36, true) / 10 : null,
      ecu_v: has(V.ECU_V) ? d.getUint16(40, true) / 1000 : null,
      flags: b[43],
    });
  }
  return { samples, rejected };
}
