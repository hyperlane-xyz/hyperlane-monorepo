import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';
import { expect } from 'chai';

import { isMessageDelivered } from './mailbox-query.js';

function getGateway(
  programmaticJson: unknown,
): Pick<GatewayApiClient, 'transaction'> {
  return {
    transaction: {
      innerClient: {
        transactionConstruction: async () => ({
          ledger_state: { epoch: 1 },
        }),
        transactionPreview: async () => ({
          receipt: {
            output: [{ programmatic_json: programmaticJson }],
          },
        }),
      },
    },
  } as Pick<GatewayApiClient, 'transaction'>;
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
});
