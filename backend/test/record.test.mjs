// The 48-byte record: decoder (src/record.ts) and encoder (scripts/lib/record-encode.mjs)
// against the golden record of the change contract. The firmware host test checks the same
// bytes against firmware/include/record.h, so the three copies of the layout cannot drift.
import assert from "node:assert/strict";
import { test } from "node:test";
import { crc16 as crcEnc, encodeRecord, F as F_ENC, joinRecords, REC_SIZE as SIZE_ENC, V as V_ENC } from "../scripts/lib/record-encode.mjs";
import { crc16, decode, engineOn, F, REC_SIZE, V } from "../src/record";

const GOLDEN_HEX = "c8010c0040e201003beff46ad8db8a16684bffb66608d2046437890336015817bf15ff0ff7ee0100e2360b01ad02077c";
const GOLDEN_FIELDS = {
  boot: 12, inst: 173, fw: 2, ms: 123456, epoch: 1794436923, flags: 1,
  lat: 37.8199, lon: -122.4783, sats: 11, rpm: 2150, maf_gs: 12.34, adapter_v: 14.18, coolant_c: 90.5,
  intake_c: 31, speed_kph: 88, throttle_pct: 23, fuel_raw: 191, csq: 21, odo_km: 12671.1, ecu_v: 14.05,
};
const GOLDEN_DECODED = {
  boot: 11337740, ms: 123456, epoch: 1794436923, lat: 37.8199, lon: -122.4783, sats: 11, rpm: 2150,
  maf_gs: 12.34, adapter_v: 14.18, coolant_c: 90.5, intake_c: 31, speed_kph: 88, throttle_pct: 23,
  fuel_pct: 74.9, csq: 21, odo_km: 12671.1, ecu_v: 14.05, flags: 1, fw: 2,
};

const fromHex = (hex) => new Uint8Array(Buffer.from(hex, "hex"));
const toHex = (bytes) => Buffer.from(bytes).toString("hex");
// decode() takes an ArrayBuffer, like Request.arrayBuffer() gives the Worker.
const dec = (bytes) => decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

test("the golden record decodes to exactly the contract's values", () => {
  const out = dec(fromHex(GOLDEN_HEX));
  assert.equal(out.rejected, 0);
  assert.equal(out.unknownVersion, 0);
  assert.deepEqual(out.samples, [GOLDEN_DECODED]);
});

test("the golden record's raw fields sit at the contract's offsets", () => {
  const b = fromHex(GOLDEN_HEX);
  const d = new DataView(b.buffer);
  assert.equal(b.length, 48);
  assert.equal(b[0], 0xc8);
  assert.equal(b[1], 1);
  assert.equal(d.getUint16(2, true), 12);
  assert.equal(d.getUint32(4, true), 123456);
  assert.equal(d.getUint32(8, true), 1794436923);
  assert.equal(d.getInt32(12, true), 378199000);
  assert.equal(d.getInt32(16, true), -1224783000);
  assert.equal(d.getUint16(20, true), 2150);
  assert.equal(d.getUint16(22, true), 1234);
  assert.equal(d.getUint16(24, true), 14180);
  assert.equal(d.getInt16(26, true), 905);
  assert.equal(d.getInt16(28, true), 310);
  assert.deepEqual([b[30], b[31], b[32], b[33]], [88, 23, 191, 21]);
  assert.equal(d.getUint16(34, true), 0x0fff);
  assert.equal(d.getUint32(36, true), 126711);
  assert.equal(d.getUint16(40, true), 14050);
  assert.deepEqual([b[42], b[43], b[44], b[45]], [11, 1, 173, 2]);
  assert.equal(d.getUint16(46, true), 0x7c07);
  assert.equal(crc16(b, 46), 0x7c07);
});

test("the shared encoder produces exactly the golden bytes", () => {
  assert.equal(toHex(encodeRecord(GOLDEN_FIELDS)), GOLDEN_HEX);
  // fuel given in percent lands on the same raw byte
  const { fuel_raw, ...rest } = GOLDEN_FIELDS;
  assert.equal(toHex(encodeRecord({ ...rest, fuel_pct: 74.9 })), GOLDEN_HEX);
});

test("encoder and decoder agree on constants", () => {
  assert.equal(SIZE_ENC, REC_SIZE);
  assert.deepEqual({ ...V_ENC }, { ...V });
  assert.deepEqual({ ...F_ENC }, { ...F });
  assert.equal(F.NO_LINK, 4);
  const b = fromHex(GOLDEN_HEX);
  assert.equal(crcEnc(b, 46), crc16(b, 46));
});

test("a flipped bit anywhere in the record is rejected", () => {
  const good = fromHex(GOLDEN_HEX);
  for (let i = 0; i < 48; i++) {
    const bad = good.slice();
    bad[i] ^= 0x10;
    const out = dec(bad);
    assert.deepEqual([out.samples.length, out.rejected, out.unknownVersion], [0, 1, 0], `byte ${i}`);
  }
});

test("a torn tail is rejected and the whole records before it survive", () => {
  const good = fromHex(GOLDEN_HEX);
  const torn = new Uint8Array(48 + 20);
  torn.set(good);
  torn.set(good.subarray(0, 20), 48);
  const out = dec(torn);
  assert.equal(out.samples.length, 1);
  assert.equal(out.rejected, 1);
  assert.equal(out.unknownVersion, 0);
  // less than one record
  assert.deepEqual(dec(good.subarray(0, 47)), { samples: [], rejected: 1, unknownVersion: 0 });
  assert.deepEqual(dec(new Uint8Array(0)), { samples: [], rejected: 0, unknownVersion: 0 });
});

// A fixed pseudo-random byte stream (xorshift32), so a failure can be repeated.
function junk(n, seed = 1) {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

test("a torn piece in the middle of a body does not cost the records behind it", () => {
  const rec = (ms, more = {}) => encodeRecord({ ...GOLDEN_FIELDS, ms, ...more });
  const first = [1000, 2000, 3000].map((ms) => rec(ms));
  const next = [1000, 2000, 3000, 4000, 5000].map((ms) => rec(ms, { boot: 13 }));
  const want = [...first, ...next].map((r) => dec(r).samples[0]);
  assert.equal(want.length, 8);

  // What older firmware sends when a segment file ends in a cut-off record: the segments
  // back to back, so everything behind the torn piece is off the 48-byte grid.
  for (let cut = 1; cut < 48; cut++) {
    const out = dec(joinRecords([...first, rec(4000).subarray(0, cut), ...next]));
    assert.deepEqual(out.samples, want, `torn piece of ${cut} bytes`);
    assert.deepEqual([out.rejected, out.unknownVersion], [1, 0], `torn piece of ${cut} bytes`);
  }

  // Each damaged stretch counts once, however long it is: a torn piece, two flipped records
  // in a row and a torn tail are three.
  const flipped = (r) => { const bad = r.slice(); bad[21] ^= 0x40; return bad; };
  const out = dec(joinRecords([first[0], rec(4000).subarray(0, 20), first[1], flipped(first[2]), flipped(next[0]), next[1], next[2].subarray(0, 30)]));
  assert.deepEqual(out.samples, [want[0], want[1], want[4]]);
  assert.equal(out.rejected, 3);

  // An intact record of an unknown version behind a torn piece is still seen as intact, so
  // the upload is refused and not thrown away.
  const v2 = dec(joinRecords([first[0], rec(4000).subarray(0, 20), rec(5000, { version: 2 }), next[0]]));
  assert.deepEqual([v2.samples.length, v2.rejected, v2.unknownVersion], [2, 1, 1]);
});

test("a record torn one byte short whose CRC ends in the magic byte keeps the record behind it", () => {
  const rec = (ms, more = {}) => encodeRecord({ ...GOLDEN_FIELDS, ms, ...more });
  // A record whose CRC high byte (its last byte) is the magic byte, 1 in 256 of them.
  let rpm = 0;
  while (rec(4000, { rpm })[47] !== 0xc8) rpm++;
  const odd = rec(4000, { rpm });
  const first = [1000, 2000, 3000].map((ms) => rec(ms));
  const next = [5000, 6000, 7000].map((ms) => rec(ms));
  const one = (r) => dec(r).samples[0];

  // Its first 47 bytes and the next record's magic byte read as the whole record, so its data
  // is kept, and nothing is lost behind it either.
  for (const after of [next, next.slice(0, 1)]) {
    const label = `${after.length} records behind the torn one`;
    const out = dec(joinRecords([...first, odd.subarray(0, 47), ...after]));
    assert.deepEqual(out.samples, [...first, odd, ...after].map(one), label);
    assert.deepEqual([out.rejected, out.unknownVersion], [0, 0], label);
  }

  // The same record whole, and the same record whole with damage behind it, decode as before.
  assert.deepEqual(dec(joinRecords([...first, odd, ...next])).samples, [...first, odd, ...next].map(one));
  const flipped = next[0].slice();
  flipped[21] ^= 0x40;
  const out = dec(joinRecords([first[0], odd, flipped, next[1]]));
  assert.deepEqual(out.samples, [first[0], odd, next[1]].map(one));
  assert.equal(out.rejected, 1);
});

test("garbage decodes to nothing and counts as one damaged stretch", () => {
  for (const n of [1, 47, 48, 49, 96, 1000, 16368, 65536]) {
    assert.deepEqual(dec(junk(n, n)), { samples: [], rejected: 1, unknownVersion: 0 }, `${n} random bytes`);
    assert.deepEqual(dec(new Uint8Array(n)), { samples: [], rejected: 1, unknownVersion: 0 }, `${n} zero bytes`);
  }
  // The most work the search can have: the largest body, and every byte looks like a record start.
  assert.deepEqual(dec(new Uint8Array(65536).fill(0xc8)), { samples: [], rejected: 1, unknownVersion: 0 });
});

test("the golden record is found after 1 to 47 junk bytes", () => {
  const good = fromHex(GOLDEN_HEX);
  for (let n = 1; n < 48; n++) {
    const kinds = {
      zero: new Uint8Array(n),
      random: junk(n, 1000 + n),
      "magic bytes": new Uint8Array(n).fill(0xc8),
      "the start of a record": good.subarray(0, n),
    };
    for (const [name, lead] of Object.entries(kinds)) {
      const label = `${n} bytes, ${name}`;
      assert.deepEqual(dec(joinRecords([lead, good])), { samples: [GOLDEN_DECODED], rejected: 1, unknownVersion: 0 }, label);
      // And again with a record in front and junk behind.
      const out = dec(joinRecords([good, lead, good, lead]));
      assert.deepEqual(out.samples, [GOLDEN_DECODED, GOLDEN_DECODED], label);
      assert.equal(out.rejected, 2, label);
    }
  }
});

test("an intact record with another version counts as unknownVersion, not as rejected", () => {
  const v2 = encodeRecord({ ...GOLDEN_FIELDS, version: 2 });
  assert.equal(crc16(v2, 46), new DataView(v2.buffer).getUint16(46, true), "the CRC of the version 2 record is good");
  assert.deepEqual(dec(v2), { samples: [], rejected: 0, unknownVersion: 1 });

  const mixed = dec(joinRecords([encodeRecord(GOLDEN_FIELDS), v2, encodeRecord({ ...GOLDEN_FIELDS, version: 0 })]));
  assert.equal(mixed.samples.length, 1);
  assert.equal(mixed.rejected, 0);
  assert.equal(mixed.unknownVersion, 2);
});

test("a wrong version with a bad CRC, or a wrong magic, is plain damage", () => {
  const v2 = encodeRecord({ ...GOLDEN_FIELDS, version: 2 });
  v2[20] ^= 1;
  assert.deepEqual(dec(v2), { samples: [], rejected: 1, unknownVersion: 0 });
  const magic = encodeRecord({ ...GOLDEN_FIELDS, magic: 0xc9 });
  assert.deepEqual(dec(magic), { samples: [], rejected: 1, unknownVersion: 0 });
});

test("the install id is folded into the session id, legacy records keep their number", () => {
  const id = (fields) => dec(encodeRecord({ ms: 1, ...fields })).samples[0];
  assert.equal(id({ boot: 12, inst: 0 }).boot, 12);
  assert.equal(id({ boot: 12 }).fw, 0);
  assert.equal(id({ boot: 12, inst: 1 }).boot, 65548);
  assert.equal(id({ boot: 65535, inst: 255 }).boot, 255 * 65536 + 65535);
  assert.equal(id({ boot: 12, inst: 173, fw: 3 }).fw, 3);
  // the same counter on two boards gives two sessions
  assert.notEqual(id({ boot: 7, inst: 4 }).boot, id({ boot: 7, inst: 5 }).boot);
});

test("fields without their valid bit decode to null", () => {
  const s = dec(encodeRecord({ boot: 3, ms: 5000, flags: F.NO_LINK, lat: 37.8199, lon: -122.4783, sats: 6, csq: 18 })).samples[0];
  assert.deepEqual(s, {
    boot: 3, ms: 5000, epoch: 0, lat: 37.8199, lon: -122.4783, sats: 6, rpm: null, maf_gs: null, adapter_v: null,
    coolant_c: null, intake_c: null, speed_kph: null, throttle_pct: null, fuel_pct: null, csq: 18, odo_km: null,
    ecu_v: null, flags: 4, fw: 0,
  });
  // negative temperatures are signed
  assert.equal(dec(encodeRecord({ boot: 3, ms: 1, coolant_c: -12.5, intake_c: -40 })).samples[0].coolant_c, -12.5);
});

test("a record without the adapter link never counts as engine-on", () => {
  assert.equal(engineOn(F.ENGINE_ON), true);
  assert.equal(engineOn(F.ENGINE_ON | F.QUIET), true);
  assert.equal(engineOn(0), false);
  assert.equal(engineOn(F.NO_LINK), false);
  assert.equal(engineOn(F.NO_LINK | F.ENGINE_ON), false);
});
