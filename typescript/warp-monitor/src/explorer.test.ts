import { expect } from 'chai';
import sinon from 'sinon';

import { rootLogger } from '@hyperlane-xyz/utils';

import {
  ExplorerPendingTransfersClient,
  canonical18ToTokenBaseUnits,
  normalizeExplorerAddress,
  normalizeExplorerHex,
  type RouterNodeMetadata,
} from './explorer.js';

describe('Explorer Pending Transfers', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('normalize helpers', () => {
    it('normalizes postgres bytea hex', () => {
      expect(normalizeExplorerHex('\\x1234')).to.equal('0x1234');
      expect(normalizeExplorerHex('0x1234')).to.equal('0x1234');
    });

    it('normalizes padded 32-byte addresses to EVM address', () => {
      const padded =
        '0x0000000000000000000000001111111111111111111111111111111111111111';
      expect(normalizeExplorerAddress(padded)).to.equal(
        '0x1111111111111111111111111111111111111111',
      );
    });

    it('converts canonical18 amount to token base units', () => {
      const canonicalAmount = 1234567890000000000n;
      expect(canonical18ToTokenBaseUnits(canonicalAmount, 18)).to.equal(
        canonicalAmount,
      );
      expect(canonical18ToTokenBaseUnits(canonicalAmount, 6)).to.equal(
        1234567n,
      );
      expect(canonical18ToTokenBaseUnits(1n, 20)).to.equal(100n);
    });
  });

  it('maps explorer inflight messages to destination nodes', async () => {
    const router = '0x00000000000000000000000000000000000000aa';
    const nodes: RouterNodeMetadata[] = [
      {
        nodeId: 'USDC|base|0xrouter',
        chainName: 'base' as any,
        domainId: 8453,
        routerAddress: router,
        tokenAddress: '0x00000000000000000000000000000000000000bb',
        tokenName: 'USD Coin',
        tokenSymbol: 'USDC',
        tokenDecimals: 6,
        token: {} as any,
      },
    ];

    const amountCanonical18 = 1234567890000000000n;
    const amountHex = amountCanonical18.toString(16).padStart(64, '0');
    const recipientBytes32 =
      '0000000000000000000000003333333333333333333333333333333333333333';
    const malformedRecipientBytes32 =
      '1111111111111111111111113333333333333333333333333333333333333333';
    const messageBody = `0x${recipientBytes32}${amountHex}`;
    const malformedRecipientBody = `0x${malformedRecipientBytes32}${amountHex}`;

    sinon.stub(globalThis, 'fetch' as any).resolves({
      ok: true,
      json: async () => ({
        data: {
          message_view: [
            {
              msg_id:
                '\\xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              origin_domain_id: 42161,
              destination_domain_id: 8453,
              sender: '\\xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              recipient:
                '\\x00000000000000000000000000000000000000000000000000000000000000aa',
              message_body: messageBody,
              send_occurred_at: new Date(Date.now() - 60_000).toISOString(),
            },
            // wrong destination router, should be ignored
            {
              msg_id:
                '\\xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
              origin_domain_id: 42161,
              destination_domain_id: 8453,
              sender: '\\xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              recipient:
                '\\x00000000000000000000000000000000000000000000000000000000000000ff',
              message_body: messageBody,
              send_occurred_at: null,
            },
            // malformed recipient bytes32, should be ignored
            {
              msg_id:
                '\\xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
              origin_domain_id: 42161,
              destination_domain_id: 8453,
              sender: '\\xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              recipient:
                '\\x00000000000000000000000000000000000000000000000000000000000000aa',
              message_body: malformedRecipientBody,
              send_occurred_at: null,
            },
          ],
        },
      }),
    } as any);

    const client = new ExplorerPendingTransfersClient(
      'https://explorer.example/v1/graphql',
      nodes,
      rootLogger,
    );

    const transfers = await client.getPendingDestinationTransfers();

    expect(transfers).to.have.length(1);
    expect(transfers[0].destinationNodeId).to.equal('USDC|base|0xrouter');
    expect(transfers[0].destinationDomainId).to.equal(8453);
    expect(transfers[0].destinationRouter).to.equal(router);
    expect(transfers[0].amountBaseUnits).to.equal(1234567n);
    expect(transfers[0].sendOccurredAtMs).to.be.a('number');
  });
});
