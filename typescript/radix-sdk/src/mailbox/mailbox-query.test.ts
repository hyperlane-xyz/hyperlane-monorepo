import {
  GatewayApiClient,
  Transaction,
  TransactionApi,
  type TransactionConstructionResponse,
  type TransactionPreviewResponse,
} from '@radixdlt/babylon-gateway-api-sdk';
import { expect } from 'chai';

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

    expect(delivered).to.equal(true);
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

    expect(numericDelivered).to.equal(true);
    expect(stringDelivered).to.equal(false);
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

    expect(bigintDelivered).to.equal(true);
    expect(bigintUndelivered).to.equal(false);
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

    expect(String(error)).to.match(/Unexpected delivered\(\) output shape/i);
  });
});
