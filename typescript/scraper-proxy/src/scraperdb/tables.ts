export type TableName = 'domain' | 'message_view' | 'raw_message_dispatch';

export interface TableConfig {
  columnSet: ReadonlySet<string>;
  columns: readonly string[];
  primaryKey?: string;
}

export const tables: Record<TableName, TableConfig> = {
  domain: table(
    [
      'chain_id',
      'id',
      'is_deprecated',
      'is_test_net',
      'name',
      'native_token',
      'time_created',
      'time_updated',
    ],
    'id',
  ),
  message_view: table([
    'delivery_latency',
    'delivery_occurred_at',
    'delivery_scape_latency',
    'delivery_scraped_at',
    'destination_block_hash',
    'destination_block_height',
    'destination_block_id',
    'destination_chain_id',
    'destination_domain',
    'destination_domain_id',
    'destination_mailbox',
    'destination_tx_cumulative_gas_used',
    'destination_tx_effective_gas_price',
    'destination_tx_gas_limit',
    'destination_tx_gas_price',
    'destination_tx_gas_used',
    'destination_tx_hash',
    'destination_tx_id',
    'destination_tx_max_fee_per_gas',
    'destination_tx_max_priority_fee_per_gas',
    'destination_tx_nonce',
    'destination_tx_recipient',
    'destination_tx_sender',
    'id',
    'is_delivered',
    'message_body',
    'msg_id',
    'nonce',
    'num_payments',
    'origin_block_hash',
    'origin_block_height',
    'origin_block_id',
    'origin_chain_id',
    'origin_domain',
    'origin_domain_id',
    'origin_mailbox',
    'origin_tx_cumulative_gas_used',
    'origin_tx_effective_gas_price',
    'origin_tx_gas_limit',
    'origin_tx_gas_price',
    'origin_tx_gas_used',
    'origin_tx_hash',
    'origin_tx_id',
    'origin_tx_max_fee_per_gas',
    'origin_tx_max_priority_fee_per_gas',
    'origin_tx_nonce',
    'origin_tx_recipient',
    'origin_tx_sender',
    'recipient',
    'send_occurred_at',
    'send_scape_latency',
    'send_scraped_at',
    'sender',
    'total_gas_amount',
    'total_payment',
  ]),
  raw_message_dispatch: table(
    [
      'destination_domain',
      'id',
      'msg_body',
      'msg_id',
      'nonce',
      'origin_block_hash',
      'origin_block_height',
      'origin_domain',
      'origin_mailbox',
      'origin_tx_hash',
      'recipient',
      'sender',
      'time_created',
    ],
    'id',
  ),
};

function table(columns: readonly string[], primaryKey?: string): TableConfig {
  return {
    columns,
    columnSet: new Set(columns),
    primaryKey,
  };
}

export function assertColumn(table: TableName, column: string): void {
  if (!tables[table].columnSet.has(column)) {
    throw new Error(`Unsupported column ${table}.${column}`);
  }
}

export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
