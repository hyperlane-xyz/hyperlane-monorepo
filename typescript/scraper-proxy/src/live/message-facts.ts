import type { Row } from './event-store.js';
import { MAX_MESSAGE_FACTS } from './provisional-message.js';
import { parseDatabaseDomain, parseId } from './protocol.js';

type PaymentBucket = {
  domain: number;
  height: string | null;
  first: string | null;
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
  deliveries: Delivery[];
  payments: {
    domain: number;
    height: bigint | null;
    first: bigint | null;
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
      if ((payment_buckets?.length ?? 0) > MAX_MESSAGE_FACTS)
        throw new Error('Message payment bucket limit exceeded');
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
        first: b.first == null ? null : parseId(b.first),
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
        deliveries: [],
        bytes:
          Buffer.byteLength(JSON.stringify(pending)) +
          Buffer.byteLength(JSON.stringify(payment_buckets)),
      };
      facts.set(data.msg_id, message);
    }
    if (delivery_domain != null) {
      if (message.deliveries.length >= MAX_MESSAGE_FACTS)
        throw new Error('Message delivery limit exceeded');
      const domain = parseDatabaseDomain(
        delivery_domain,
        'Invalid delivery domain',
      );
      message.dependencies.add(domain);
      message.deliveries.push({
        domain,
        height: delivery_height === null ? null : parseId(delivery_height),
        fields,
      });
      message.bytes += Buffer.byteLength(JSON.stringify(fields));
    }
  }
  return facts;
}

export function projectMessage(
  facts: MessageFacts,
  frontier: (domain: number) => bigint | undefined,
) {
  const visible = (domain: number, height: bigint | null) => {
    const limit = frontier(domain);
    return height === null || limit === undefined || height <= limit;
  };
  if (!visible(facts.origin, facts.height)) return;
  // SQL returns deliveries in block_number DESC NULLS LAST, id DESC order.
  const delivery = facts.deliveries.find((d) => visible(d.domain, d.height));
  let count = 0n,
    payment = 0n,
    gas = 0n;
  const domains = new Set([facts.origin, facts.destination]);
  if (delivery) domains.add(delivery.domain);
  for (const bucket of facts.payments) {
    if (!visible(bucket.domain, bucket.height)) {
      if (bucket.first !== null && visible(bucket.domain, bucket.first))
        throw new Error('Message cursor predates payment baseline');
      continue;
    }
    domains.add(bucket.domain);
    count += bucket.count;
    payment += bucket.payment;
    gas += bucket.gas;
  }
  const data: Row = {
    ...facts.pending,
    ...delivery?.fields,
    is_delivered: !!delivery,
    num_payments: String(count),
    total_payment: String(payment),
    total_gas_amount: String(gas),
  };
  return { data, domains: [...domains] };
}
