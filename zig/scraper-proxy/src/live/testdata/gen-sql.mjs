// Regenerate: (cd typescript/scraper-proxy && pnpm build) then
//   DATABASE_URL=postgres://x/y node zig/scraper-proxy/src/live/testdata/gen-sql.mjs > zig/scraper-proxy/src/live/testdata/sql.json
// Records every EventStore query (SQL text + parameters) for the Zig golden test.
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../typescript/scraper-proxy',
);
const { EventStore } = await import(
  path.join(root, 'dist/live/event-store.js')
);

const cases = [];
let current;
const store = new EventStore({
  async queryLive(sql, values = []) {
    cases.push({ name: current, sql, values });
    return [];
  },
});
async function run(name, fn) {
  current = name;
  const result = fn();
  if (result && typeof result[Symbol.asyncIterator] === 'function') {
    for await (const _ of result);
  } else await result;
}
const types = ['dispatch', 'delivery', 'gas_payment', 'merkle_tree_insertion'];
const seq = {
  kind: 'sequence',
  domain: 4294967295,
  address: '\\x' + '01'.repeat(20),
};
const gas = {
  kind: 'gas_payment',
  domain: 1,
  address: '\\x' + '02'.repeat(32),
};
await run('blockHeads', () => store.blockHeads());
await run('blockHeads:domains', () =>
  store.blockHeads(new Set([1, 4294967295])),
);
await run('canonicalMessages', () =>
  store.canonicalMessages(['\\x' + 'ab'.repeat(32)]),
);
for (const t of types) {
  await run(`notifiedEvents:${t}`, () => store.notifiedEvents(t, ['1', '2']));
  await run(`headEvents:${t}`, () => store.headEvents(t, 4294967295, 5n, 10n));
  await run(`confirmationEventRows:${t}`, () =>
    store.confirmationEventRows(t, 1, [3n, 0, 7n], 10n, 2),
  );
  if (t !== 'delivery')
    await run(`confirmationEventRows:${t}:addresses`, () =>
      store.confirmationEventRows(t, 1, [3n, 0, 7n], 10n, 0, [
        '\\x' + 'aa'.repeat(20),
      ]),
    );
}
await run('confirmationMessageRows', () =>
  store.confirmationMessageRows(2147483648, [3n, 1, 7n], 10n, new Map(), 0),
);
await run('confirmationMessageRows:ids', () =>
  store.confirmationMessageRows(
    1,
    [3n, 1, 7n],
    10n,
    new Map(),
    0,
    new Set(['\\x' + 'ab'.repeat(32)]),
  ),
);
await run('provisionalMessages', () =>
  store.provisionalMessages(
    ['\\xbb', '\\xaa', '\\xbb'],
    new Map([
      [4294967295, 5n],
      [1, 7n],
    ]),
  ),
);
for (const t of ['dispatch', 'merkle_tree_insertion']) {
  await run(`sequenceRows:${t}`, () => store.sequenceRows(t, seq, 5n, 10n));
  await run(`sequenceBounds:${t}`, () => store.sequenceBounds(t, seq));
}
await run('gasPaymentRows:legacy', () =>
  store.gasPaymentRows(gas, 1n, 2n, true),
);
await run('gasPaymentRows:mapped', () =>
  store.gasPaymentRows(gas, 1n, 2n, false),
);
await run('gasPaymentCursorBounds', () => store.gasPaymentCursorBounds(gas));
process.stdout.write(JSON.stringify(cases, null, 1) + '\n');
