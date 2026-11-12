// Decoder for the 48-byte firmware Record. Mirror of firmware/include/record.h.
// scripts/lib/record-encode.mjs is the matching encoder (fake device and tests).
export const REC_SIZE = 48;
const REC_MAGIC = 0xc8;
const REC_VERSION = 1;

export const V = {
  RPM: 1 << 0, SPEED: 1 << 1, COOLANT: 1 << 2, INTAKE: 1 << 3, MAF: 1 << 4, THROTTLE: 1 << 5,
  FUEL: 1 << 6, ECU_V: 1 << 7, ODO: 1 << 8, ADAPTER_V: 1 << 9, GPS: 1 << 10, CSQ: 1 << 11,
} as const;

// NO_LINK: written while the Bluetooth link to the OBD adapter is down. Such a record carries
// only time, GPS and cell signal.
export const F = { ENGINE_ON: 1 << 0, QUIET: 1 << 1, NO_LINK: 1 << 2 } as const;

// A record written without the adapter link cannot prove a running engine, whatever bit 0 says.
export const engineOn = (flags: number) => (flags & (F.ENGINE_ON | F.NO_LINK)) === F.ENGINE_ON;

export interface Sample {
  boot: number; // session id: boot counter (u16 at offset 2) + install id (byte 44) * 65536
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
  fw: number; // firmware build byte, 0 = firmware from before the byte existed
}

// One table step per byte instead of eight shifts. decode() may run the CRC at every offset
// of a damaged body, and the Free plan allows 10 ms of CPU per request.
const CRC_TABLE = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i << 8;
  for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  CRC_TABLE[i] = c;
}

// CRC-16/CCITT-FALSE over n bytes of b, starting at `from`.
export function crc16(b: Uint8Array, n: number, from = 0): number {
  let c = 0xffff;
  for (let i = from; i < from + n; i++) c = ((c << 8) & 0xffff) ^ CRC_TABLE[(c >> 8) ^ b[i]];
  return c;
}

// `rejected` counts damaged stretches: runs of bytes that belong to no intact record (bad
// magic, bad CRC, a torn piece). `unknownVersion` counts intact records in a layout this
// decoder does not know. The caller must refuse the whole upload for those, because a 2xx
// makes the logger delete what it sent.
export function decode(buf: ArrayBuffer): { samples: Sample[]; rejected: number; unknownVersion: number } {
  const samples: Sample[] = [];
  let rejected = 0;
  let unknownVersion = 0;
  const all = new Uint8Array(buf);
  // The magic byte is tested first. It is one compare, and the search can try every offset.
  const intact = (p: number) =>
    p + REC_SIZE <= all.length && all[p] === REC_MAGIC && crc16(all, 46, p) === (all[p + 46] | (all[p + 47] << 8));
  let off = 0;
  let damaged = false; // the bytes just before `off` are a damaged stretch that is already counted
  while (off + REC_SIZE <= all.length) {
    if (!intact(off)) {
      // No record starts here. Older firmware sends its segment files back to back at their
      // raw size, so a torn one in the middle shifts every record behind it. Search byte by
      // byte for the next place where a whole intact record starts and carry on from there.
      if (!damaged) rejected++;
      damaged = true;
      off++;
      continue;
    }
    damaged = false;
    const b = all.subarray(off, off + REC_SIZE);
    const d = new DataView(buf, off, REC_SIZE);
    // A record torn one byte short, followed by the next record, still passes when its own
    // CRC high byte equals the magic byte that follows (1 in 256). Its data is whole, so it is
    // kept. Then go on from that magic byte, not one byte into the next record. Only records
    // whose last byte is the magic byte pay for the extra checks.
    off += all[off + REC_SIZE - 1] === REC_MAGIC && !intact(off + REC_SIZE) && intact(off + REC_SIZE - 1)
      ? REC_SIZE - 1
      : REC_SIZE;
    if (b[1] !== REC_VERSION) {
      unknownVersion++;
      continue;
    }
    const valid = d.getUint16(34, true);
    const has = (bit: number) => (valid & bit) !== 0;
    samples.push({
      // Two boards each count boots from 1. The install id keeps their sessions apart.
      // Legacy firmware wrote 0 here, so its sessions keep their old number.
      boot: d.getUint16(2, true) + b[44] * 65536,
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
      fw: b[45],
    });
  }
  // Too few bytes left for a record: a torn tail, unless it is the end of the stretch counted above.
  if (off < all.length && !damaged) rejected++;
  return { samples, rejected, unknownVersion };
}
