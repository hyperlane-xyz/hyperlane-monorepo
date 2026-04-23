import {
  GatewayApiClient,
  Transaction,
  TransactionApi,
  type TransactionConstructionResponse,
  type TransactionPreviewResponse,
} from '@radixdlt/babylon-gateway-api-sdk';
import { describe, expect, it } from 'vitest';

import { isMessageDelivered } from './mailbox-query.js';

class TestTransactionApi extends TransactionApi {
  constructor(private readonly programmaticJson: unknown) {
    super();
  }

  override async transactionConstruction(): Promise<TransactionConstructionResponse> {
    return {
      ledger_state: {
        network: 'stokenet',
        state_version: 1,
        proposer_round_timestamp: '0',
        epoch: 1,
        round: 1,
      },
    };
  }

  override async transactionPreview(): Promise<TransactionPreviewResponse> {
    return {
      encoded_receipt: '0x',
      receipt: {
        output: [{ programmatic_json: this.programmaticJson }],
      },
      resource_changes: [],
      logs: [],
    };
  }
}

function getGateway(
  programmaticJson: unknown,
): Pick<GatewayApiClient, 'transaction'> {
  return {
    transaction: new Transaction(new TestTransactionApi(programmaticJson)),
  };
}

describe(isMessageDelivered.name, function () {
  it('parses strict boolean output', async function () {
    const delivered = await isMessageDelivered(
      getGateway({ value: true }) as GatewayApiClient,
      'component_rdx1test',
      '0x1234',
    );

    expect(delivered).toBe(true);
  });

  it('parses numeric and string boolean output', async function () {
    const numericDelivered = await isMessageDelivered(
      getGateway({ value: 1 }) as GatewayApiClient,
      'component_rdx1test',
      '0x1234',
    );
    const stringDelivered = await isMessageDelivered(
      getGateway({ value: 'false' }) as GatewayApiClient,
      'component_rdx1test',
      '0x1234',
    );

    expect(numericDelivered).toBe(true);
    expect(stringDelivered).toBe(false);
  });

  it('parses bigint boolean output', async function () {
    const bigintDelivered = await isMessageDelivered(
      getGateway({ value: 1n }) as GatewayApiClient,
      'component_rdx1test',
      '0x1234',
    );
    const bigintUndelivered = await isMessageDelivered(
      getGateway({ value: 0n }) as GatewayApiClient,
      'component_rdx1test',
      '0x1234',
    );

    expect(bigintDelivered).toBe(true);
    expect(bigintUndelivered).toBe(false);
  });

  it('throws on malformed boolean output', async function () {
    let error: unknown;
    try {
      await isMessageDelivered(
        getGateway({ value: 'nope' }) as GatewayApiClient,
        'component_rdx1test',
        '0x1234',
      );
    } catch (caughtError: unknown) {
      error = caughtError;
    }

    expect(String(error)).toMatch(/Unexpected delivered\(\) output shape/i);
  });
});
