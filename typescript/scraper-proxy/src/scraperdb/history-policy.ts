import { assert } from '@hyperlane-xyz/utils/validation';

import type { MessageSelectArgs } from './scraperdb.service.js';

function record(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

// Only unconditional conjuncts establish a bound. An OR branch cannot widen it.
export function validateHistoryRequest(
  args: MessageSelectArgs,
  aggregate = false,
): void {
  let identified = false;
  let provisional = false;
  let filtersDelivery = false;
  let predicates = 0;

  function visit(where: unknown, required: boolean, depth: number): void {
    if (!record(where)) return;
    assert(depth <= 8, 'History filter is nested too deeply');
    for (const [key, value] of Object.entries(where)) {
      assert(++predicates <= 100, 'Too many history predicates');
      if (key === '_and' || key === '_or') {
        if (Array.isArray(value)) {
          assert(value.length <= 100, 'Too many history predicates');
          for (const child of value)
            visit(child, required && key === '_and', depth + 1);
        }
        continue;
      }
      if (!record(value)) continue;
      if (
        required &&
        ['id', 'msg_id', 'origin_tx_hash', 'destination_tx_hash'].includes(key)
      ) {
        identified ||=
          typeof value._eq === 'string' ||
          typeof value._eq === 'number' ||
          (Array.isArray(value._in) &&
            value._in.length > 0 &&
            value._in.every((id) => typeof id === 'string'));
      }
      if (key === 'is_provisional' && required && value._eq === true)
        provisional = true;
      if (key === 'is_delivered' && value._eq != null) filtersDelivery = true;
      if (key === 'send_occurred_at')
        assert(
          value._is_null !== true,
          'Only non-null send times may be requested',
        );
    }
  }
  visit(args.where, true, 0);

  const overlay = args.confirmations === 0 && provisional;
  assert(
    !aggregate || identified,
    'History aggregates require an exact message or transaction identifier',
  );
  assert(
    args.confirmations == null || identified || overlay,
    'Custom confirmations require a message or transaction identifier, or a zero-confirmation provisional feed',
  );
  assert(
    !filtersDelivery || overlay,
    'Delivery status filters require a provisional-only feed',
  );
  const orders = Array.isArray(args.order_by) ? args.order_by : [args.order_by];
  for (const order of orders) {
    if (!order) continue;
    for (const [name, direction] of Object.entries(order)) {
      if (!direction || name === 'id') continue;
      assert(
        (name === 'nonce' && identified) ||
          (name === 'send_occurred_at' && overlay),
        'Use ID ordering for history, nonce for an identifier, or send time for a provisional-only feed',
      );
    }
  }
}
