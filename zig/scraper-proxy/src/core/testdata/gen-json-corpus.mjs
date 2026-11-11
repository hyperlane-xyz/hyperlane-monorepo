// Generates a differential corpus for core.json against Node's JSON.stringify.
// Usage (from zig/): node src/core/testdata/gen-json-corpus.mjs > src/core/testdata/json-corpus.json
// Values are encoded losslessly (numbers as IEEE-754 bits, strings as UTF-16
// code units) so lone surrogates, -0, NaN and Infinity survive the trip.
let state = 0x5eed1234;
function rand() {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (n) => Math.floor(rand() * n);
const pick = (items) => items[int(items.length)];

const view = new DataView(new ArrayBuffer(8));
function bits(n) {
  view.setFloat64(0, n);
  return view.getBigUint64(0).toString(16).padStart(16, '0');
}
function randomDouble() {
  view.setUint32(0, int(2 ** 32));
  view.setUint32(4, int(2 ** 32));
  return view.getFloat64(0);
}

const edgeNumbers = [
  0,
  -0,
  NaN,
  Infinity,
  -Infinity,
  1,
  -1,
  0.1,
  0.2,
  0.30000000000000004,
  1e21,
  1e20,
  999999999999999900000,
  1e-6,
  1e-7,
  1.5e-7,
  0.000001,
  0.0000012345,
  5e-324,
  Number.MAX_VALUE,
  Number.MIN_VALUE,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 1,
  Number.MAX_SAFE_INTEGER + 2,
  -Number.MAX_SAFE_INTEGER,
  2 ** 53,
  2 ** 64,
  2 ** 31 - 1,
  2 ** 31,
  -(2 ** 31),
  2 ** 32,
  4294967295,
  123456789012345680000,
  1.7976931348623157e308,
  2.2250738585072014e-308,
  100,
  1000000,
  10000000000,
  12345.678,
  1.0,
  1.5,
  -1.5e-10,
  9.95,
  0.5,
  1 / 3,
];
function randomNumber() {
  switch (int(8)) {
    case 0:
      return pick(edgeNumbers);
    case 1:
      return randomDouble();
    case 2:
      return int(1000) - 500;
    case 3:
      return (rand() < 0.5 ? -1 : 1) * int(2 ** 31) * 2 ** int(30);
    case 4:
      return Number((rand() * 1000).toFixed(int(8)));
    case 5:
      return (int(2000) - 1000) * 10 ** (int(60) - 30);
    case 6:
      return rand() * 10 ** (int(40) - 20);
    default:
      return int(2 ** 53) * (rand() < 0.5 ? -1 : 1);
  }
}

const unitClasses = [
  () => 0x20 + int(0x5f), // printable ASCII
  () => pick([0x22, 0x5c, 0x2f]), // " \ /
  () => int(0x20), // controls
  () => 0x7f,
  () => 0x80 + int(0x780), // 2-byte UTF-8
  () => pick([0x2028, 0x2029, 0xfeff, 0xfffd, 0xffff]),
  () => 0x800 + int(0xd000), // BMP below surrogates
  () => 0xe000 + int(0x2000),
  () => 0xd800 + int(0x400), // lone high
  () => 0xdc00 + int(0x400), // lone low
];
function randomUnits(maxLen) {
  const units = [];
  const len = int(maxLen + 1);
  while (units.length < len) {
    if (rand() < 0.1) {
      units.push(0xd800 + int(0x400), 0xdc00 + int(0x400)); // valid pair
    } else if (rand() < 0.6) {
      units.push(0x61 + int(26)); // long clean runs exercise the fast path
    } else {
      units.push(pick(unitClasses)());
    }
  }
  return units;
}
const indexKeys = [
  '0',
  '1',
  '2',
  '10',
  '01',
  '-1',
  '4294967294',
  '4294967295',
  '9007199254740993',
  '1.5',
  '',
];

function randomValue(depth) {
  const r = int(depth > 3 ? 6 : 9);
  if (r === 0) return null;
  if (r === 1) return rand() < 0.5;
  if (r <= 3) return randomNumber();
  if (r <= 5)
    return String.fromCharCode(...randomUnits(rand() < 0.2 ? 80 : 12));
  if (r === 6)
    return Array.from({ length: int(5) }, () => randomValue(depth + 1));
  const object = {};
  for (let i = int(6); i > 0; i--) {
    const key =
      rand() < 0.3 ? pick(indexKeys) : String.fromCharCode(...randomUnits(6));
    object[key] = randomValue(depth + 1);
  }
  return object;
}

// Encoding keeps generation (insertion) order for objects; Object.keys
// already applies the index-first ordering the Zig serializer must reproduce,
// so encode in insertion order by recording keys as they are assigned.
function encode(value, order) {
  if (value === null) return { t: 'z' };
  if (typeof value === 'boolean') return { t: 'b', v: value };
  if (typeof value === 'number') return { t: 'n', b: bits(value) };
  if (typeof value === 'string')
    return {
      t: 's',
      u: Array.from({ length: value.length }, (_, i) => value.charCodeAt(i)),
    };
  if (Array.isArray(value))
    return { t: 'a', v: value.map((item) => encode(item, order)) };
  const keys = order.get(value) ?? Object.keys(value);
  return {
    t: 'o',
    v: keys.map((key) => [encode(key, order), encode(value[key], order)]),
  };
}

// Rebuild objects while remembering raw insertion order (shuffled so index
// keys are not already first).
function withOrder(value, order) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => withOrder(item, order));
  const keys = Object.keys(value);
  for (let i = keys.length - 1; i > 0; i--) {
    const j = int(i + 1);
    [keys[i], keys[j]] = [keys[j], keys[i]];
  }
  const copy = {};
  for (const key of keys) copy[key] = withOrder(value[key], order);
  order.set(copy, keys);
  return copy;
}

const cases = [];
for (let i = 0; i < 3000; i++) {
  const order = new Map();
  const value = withOrder(randomValue(0), order);
  cases.push({ value: encode(value, order), json: JSON.stringify(value) });
}
for (const n of edgeNumbers)
  cases.push({ value: encode(n, new Map()), json: JSON.stringify(n) });
process.stdout.write(`${JSON.stringify({ cases })}\n`);
