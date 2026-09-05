# Token balance observation logs

The shared token balance updater now includes available USD value in the existing
`Wallet balance updated for token` INFO event. The separate value event remains
at DEBUG. Zero USD remains present; nullish values are omitted. All gauge updates,
the balance event's placement, and failure propagation remain unchanged. Queries
for the separate INFO value message should use the balance message's `valueUSD`
field instead. No repository alert rule was found using the old message; external
log queries were not audited.

A bounded read-only last-hour sample from 15 mainnet pods (14 rebalancers and the
central monitor), capped at 15,000 lines per pod with no cap reached, contained
4,688 balance events and 2,778 value events. Consolidation would remove 2,778 of
7,466 events (37.2%) while retaining every balance observation. A separately
sampled private-agents Moonpay pod is excluded from this estimate.

The value events occupied 1,835,423 raw JSON line bytes. This is not the net saving:
each priced balance event gains a USD field. With a synthetic USD value of
12.345678901234567, Pino adds 30 bytes per balance record; applying that assumption
to the observed event count gives a modeled net reduction of 1,752,083 bytes in
the sampled hour. Actual USD number lengths vary. This is neither a deployed
measurement nor a compressed storage, CPU, or billing claim.

Reproduce the byte fixture from `typescript/metrics`:

```sh
node --input-type=module <<'JS'
import { pino } from 'pino';
const records = [];
const logger = pino({ level: 'info', timestamp: false, base: null }, {
  write: (record) => records.push(record),
});
const labels = {
  chain_name: 'ethereum', token_name: 'Token', warp_route_id: 'TEST/metric-logging',
};
logger.info({ labels, balance: 3 }, 'Wallet balance updated for token');
logger.info({ labels, valueUSD: 12.345678901234567 }, 'Wallet value updated for token');
logger.info({ labels, balance: 3, valueUSD: 12.345678901234567 }, 'Wallet balance updated for token');
console.log(records.map((record) => Buffer.byteLength(record)));
// [160, 176, 190]: old pair 336 bytes, consolidated record 190 bytes.
JS
```

`pnpm test` covers actual Pino INFO/DEBUG output, zero and missing prices, and
identical Prometheus output across log levels. The 20-chain priced fixture emits
one INFO event (previously two) and retains all 22 DEBUG-level events.
