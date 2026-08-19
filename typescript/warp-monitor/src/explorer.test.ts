import { expect } from 'chai';
import sinon from 'sinon';

import { rootLogger } from '@hyperlane-xyz/utils';

import {
  ExplorerPendingTransfersClient,
  messageAmountToTokenBaseUnits,
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

    it('converts message amount to token base units using scale', () => {
      const messageAmount = 1234567890000000000n;
      expect(messageAmountToTokenBaseUnits(messageAmount, 1)).to.equal(
        messageAmount,
      );
      expect(
        messageAmountToTokenBaseUnits(messageAmount, 1_000_000_000_000),
      ).to.equal(1234567n);
      expect(
        messageAmountToTokenBaseUnits(messageAmount, {
          numerator: 1,
          denominator: 1_000_000_000_000,
        }),
      ).to.equal(messageAmount * 1_000_000_000_000n);
      expect(messageAmountToTokenBaseUnits(100n, 1)).to.equal(100n);
      expect(messageAmountToTokenBaseUnits(100n, 10)).to.equal(10n);
    });

    it('throws on invalid scale', () => {
      expect(() => messageAmountToTokenBaseUnits(1n, 0)).to.throw(
        'Scale must be positive',
      );
      expect(() =>
        messageAmountToTokenBaseUnits(1n, { numerator: 0, denominator: 1 }),
      ).to.throw('Scale must be positive');
    });
  });

  it('maps explorer inflight messages to destination nodes', async () => {
    const fallbackScrapedAt = '2026-08-18T20:00:00.000Z';
    const router = '0x00000000000000000000000000000000000000aa';
    const nodes: RouterNodeMetadata[] = [
      {
        nodeId: 'USDC|base|0xrouter',
        chainName: 'base',
        domainId: 8453,
        routerAddress: router,
        tokenAddress: '0x00000000000000000000000000000000000000bb',
        tokenName: 'USD Coin',
        tokenSymbol: 'USDC',
        tokenDecimals: 6,
        tokenScale: 1_000_000_000_000,
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

    const fetchStub = sinon.stub(globalThis, 'fetch' as any).resolves({
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
              send_occurred_at: null,
              send_scraped_at: fallbackScrapedAt,
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
    expect(transfers[0].sendOccurredAtMs).to.equal(
      Date.parse(fallbackScrapedAt),
    );

    const request = JSON.parse(fetchStub.firstCall.args[1].body);
    expect(request.query).to.contain('order_by: { id: desc }');
    expect(request.query).to.contain('send_scraped_at');
  });

  it('throws when explorer returns GraphQL errors', async () => {
    const nodes: RouterNodeMetadata[] = [
      {
        nodeId: 'USDC|base|0xrouter',
        chainName: 'base',
        domainId: 8453,
        routerAddress: '0x00000000000000000000000000000000000000aa',
        tokenAddress: '0x00000000000000000000000000000000000000bb',
        tokenName: 'USD Coin',
        tokenSymbol: 'USDC',
        tokenDecimals: 6,
        token: {} as any,
      },
    ];

    sinon.stub(globalThis, 'fetch' as any).resolves({
      ok: true,
      json: async () => ({
        errors: [{ message: 'boom' }],
      }),
    } as any);

    const client = new ExplorerPendingTransfersClient(
      'https://explorer.example/v1/graphql',
      nodes,
      rootLogger,
    );

    let thrown: Error | undefined;
    try {
      await client.getPendingDestinationTransfers();
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown).to.not.equal(undefined);
    expect(thrown!.message).to.contain('GraphQL errors');
  });
});
