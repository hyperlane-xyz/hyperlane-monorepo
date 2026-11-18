import assert from 'node:assert/strict';
import { it } from 'node:test';
import { once, EventEmitter } from 'node:events';
import { MessageSource } from './message-source.js';
import { collectMessageFacts } from './message-facts.js';

const initialHeads = async () =>
  new Map(
    [1, 2].map((domain) => [
      domain,
      { head: 10n, indexed: 10n, confirmed: 5n, hash: undefined },
    ]),
  );
void it('never reinstalls stale receipt data when older SQL finishes last', async () => {
  const events = new EventEmitter();
  const started = once(events, 'started');
  let calls = 0;
  const source = new MessageSource({
    messageHeads: initialHeads,
    async *messageChanges() {
      yield [];
    },
    async messageFacts() {
      const version = ++calls;
      if (version === 1) {
        const released = once(events, 'release');
        events.emit('started');
        await released;
      }
      return collectMessageFacts([
        {
          msg_id: 'id',
          origin_domain_id: 1,
          destination_domain_id: 2,
          origin_block_height: '5',
          origin_tx_gas_price: String(version),
          delivery_domain: null,
          delivery_height: null,
          payment_buckets: null,
        },
      ]);
    },
  });
  await source.currentHeads();
  const old = source.enrich(['id'], new Map());
  await started;
  source.invalidateIds(['id']);
  const fresh = await source.enrich(['id'], new Map());
  events.emit('release');
  await old;
  assert.equal(fresh[0].data.origin_tx_gas_price, '2');
  assert.deepEqual(await source.enrich(['id'], new Map()), fresh);
  assert.equal(calls, 2);
});

void it('backs off failed domain reads across reconnects while another domain continues', async () => {
  const queries: number[] = [];
  const source = new MessageSource({
    messageHeads: initialHeads,
    async *messageChanges(domain) {
      queries.push(domain);
      if (domain === 1) throw new Error('read timed out');
      yield [];
    },
    messageFacts: async () => new Map(),
  });
  await source.currentHeads();
  await assert.rejects(source.prepare(1, 9n, 10n), /read timed out/);
  await assert.rejects(source.prepare(1, 9n, 10n), /temporarily unavailable/);
  await source.prepare(2, 9n, 10n);
  assert.deepEqual(queries, [1, 2]);
});
