import type { Row } from './event-store.js';
import { MAX_PAYMENT_HEIGHTS } from './provisional-message.js';
import { parseDatabaseDomain, parseId } from './protocol.js';

type PaymentBucket = {
  domain: number;
  height: string | null;
  count: string;
  payment: string;
  gas: string;
};
export type FactRow = Row & {
  msg_id: string;
  origin_block_height: string;
  delivery_domain: number | null;
  delivery_height: string | null;
  payment_buckets: PaymentBucket[] | null;
};

type Delivery = { domain: number; height: bigint | null; fields: Row };
export type MessageFacts = {
  dependencies: Set<number>;
  origin: number;
  destination: number;
  height: bigint;
  pending: Row;
  delivery?: Delivery;
  payments: {
    domain: number;
    height: bigint | null;
    count: bigint;
    payment: bigint;
    gas: bigint;
  }[];
  bytes: number;
};

function deliveryField(key: string) {
  return (
    key === 'delivery_scraped_at' ||
    key === 'delivery_occurred_at' ||
    key === 'delivery_latency' ||
    key === 'delivery_scape_latency' ||
    key === 'destination_mailbox' ||
    key.startsWith('destination_block_') ||
    key.startsWith('destination_tx_')
  );
}

export function collectMessageFacts(rows: FactRow[]) {
  const grouped = new Map<string, FactRow[]>();
  for (const row of rows) {
    const group = grouped.get(row.msg_id) ?? [];
    group.push(row);
    grouped.set(row.msg_id, group);
  }
  const result = new Map<string, MessageFacts | Error>();
  for (const [id, group] of grouped) {
    try {
      const message = collectValidFacts(group).get(id);
      if (message) result.set(id, message);
    } catch (error) {
      result.set(id, error instanceof Error ? error : new Error(String(error)));
    }
  }
  return result;
}

function collectValidFacts(rows: FactRow[]) {
  const facts = new Map<string, MessageFacts>();
  for (const {
    delivery_height,
    delivery_domain,
    payment_buckets,
    ...data
  } of rows) {
    let message = facts.get(data.msg_id);
    const fields: Row = {};
    for (const [key, value] of Object.entries(data))
      if (deliveryField(key)) fields[key] = value;
    if (!message) {
      const origin = parseDatabaseDomain(
        data.origin_domain_id,
        'Invalid origin domain',
      );
      const destination = parseDatabaseDomain(
        data.destination_domain_id,
        'Invalid destination domain',
      );
      const pending: Row = {
        ...data,
        origin_domain_id: origin,
        destination_domain_id: destination,
        is_delivered: false,
      };
      for (const key of Object.keys(fields)) pending[key] = null;
      const payments = (payment_buckets ?? []).map((b) => ({
        domain: parseDatabaseDomain(b.domain, 'Invalid payment domain'),
        height: b.height === null ? null : parseId(b.height),
        count: parseId(b.count),
        payment: parseId(b.payment),
        gas: parseId(b.gas),
      }));
      message = {
        dependencies: new Set([
          origin,
          destination,
          ...payments.map((p) => p.domain),
        ]),
        origin,
        destination,
        height: parseId(data.origin_block_height),
        pending,
        payments,
        bytes:
          Buffer.byteLength(JSON.stringify(pending)) +
          Buffer.byteLength(JSON.stringify(payment_buckets)),
      };
      facts.set(data.msg_id, message);
    }
    // Legacy duplicate canonical rows can repeat the one delivery.
    if (delivery_domain != null && !message.delivery) {
      const domain = parseDatabaseDomain(
        delivery_domain,
        'Invalid delivery domain',
      );
      message.dependencies.add(domain);
      message.delivery = {
        domain,
        height: delivery_height === null ? null : parseId(delivery_height),
        fields,
      };
      message.bytes += Buffer.byteLength(JSON.stringify(fields));
    }
  }
  return facts;
}

export function projectMessage(
  facts: MessageFacts,
  frontier: (domain: number) => bigint | undefined,
) {
  // Highest visible fact per domain that a rollback could remove; a rollback
  // to or above it cannot change this row. Facts without a height are never
  // rewound, so they are not tracked.
  const heights = new Map<number, bigint>();
  const see = (domain: number, height: bigint) => {
    if (height > (heights.get(domain) ?? -1n)) heights.set(domain, height);
  };
  const visible = (domain: number, height: bigint | null) => {
    const limit = frontier(domain);
    if (height !== null && limit !== undefined && height > limit) return false;
    if (height !== null) see(domain, height);
    return true;
  };
  if (!visible(facts.origin, facts.height)) return;
  const delivery =
    facts.delivery && visible(facts.delivery.domain, facts.delivery.height)
      ? facts.delivery
      : undefined;
  let count = 0n,
    payment = 0n,
    gas = 0n;
  const exact = new Map<number, { buckets: number; newest: bigint }>();
  for (const bucket of facts.payments) {
    if (bucket.height !== null) {
      const domain = exact.get(bucket.domain);
      exact.set(bucket.domain, {
        buckets: (domain?.buckets ?? 0) + 1,
        newest:
          domain && domain.newest > bucket.height
            ? domain.newest
            : bucket.height,
      });
    }
    if (!visible(bucket.domain, bucket.height)) continue;
    count += bucket.count;
    payment += bucket.payment;
    gas += bucket.gas;
  }
  // A folded domain's membership is ranked from its newest payments, so any
  // rollback that removes one can move a payment into or out of the fold.
  for (const [domain, { buckets, newest }] of exact)
    if (buckets > 2 * MAX_PAYMENT_HEIGHTS) see(domain, newest);
  const data: Row = {
    ...facts.pending,
    ...delivery?.fields,
    is_delivered: !!delivery,
    num_payments: String(count),
    total_payment: String(payment),
    total_gas_amount: String(gas),
  };
  return { data, heights };
}
