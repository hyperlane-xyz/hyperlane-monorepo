import { expect, vi } from 'vitest';

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
    vi.restoreAllMocks();
  });

  describe('normalize helpers', () => {
    it('normalizes postgres bytea hex', () => {
      expect(normalizeExplorerHex('\\x1234')).toBe('0x1234');
      expect(normalizeExplorerHex('0x1234')).toBe('0x1234');
    });

    it('normalizes padded 32-byte addresses to EVM address', () => {
      const padded =
        '0x0000000000000000000000001111111111111111111111111111111111111111';
      expect(normalizeExplorerAddress(padded)).toBe(
        '0x1111111111111111111111111111111111111111',
      );
    });

    it('converts message amount to token base units using scale', () => {
      const messageAmount = 1234567890000000000n;
      expect(messageAmountToTokenBaseUnits(messageAmount, 1)).toBe(
        messageAmount,
      );
      expect(
        messageAmountToTokenBaseUnits(messageAmount, 1_000_000_000_000),
      ).toBe(1234567n);
      expect(
        messageAmountToTokenBaseUnits(messageAmount, {
          numerator: 1,
          denominator: 1_000_000_000_000,
        }),
      ).toBe(messageAmount * 1_000_000_000_000n);
      expect(messageAmountToTokenBaseUnits(100n, 1)).toBe(100n);
      expect(messageAmountToTokenBaseUnits(100n, 10)).toBe(10n);
    });

    it('throws on invalid scale', () => {
      expect(() => messageAmountToTokenBaseUnits(1n, 0)).toThrow(
        'Scale must be positive',
      );
      expect(() =>
        messageAmountToTokenBaseUnits(1n, { numerator: 0, denominator: 1 }),
      ).toThrow('Scale must be positive');
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

    vi.spyOn(globalThis, 'fetch' as any).mockResolvedValue({
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

    expect(transfers).toHaveLength(1);
    expect(transfers[0].destinationNodeId).toBe('USDC|base|0xrouter');
    expect(transfers[0].destinationDomainId).toBe(8453);
    expect(transfers[0].destinationRouter).toBe(router);
    expect(transfers[0].amountBaseUnits).toBe(1234567n);
    expect(typeof transfers[0].sendOccurredAtMs).toBe('number');
  });

  it('throws when explorer returns GraphQL errors', async () => {
    const nodes: RouterNodeMetadata[] = [
      {
        nodeId: 'USDC|base|0xrouter',
        chainName: 'base' as any,
        domainId: 8453,
        routerAddress: '0x00000000000000000000000000000000000000aa',
        tokenAddress: '0x00000000000000000000000000000000000000bb',
        tokenName: 'USD Coin',
        tokenSymbol: 'USDC',
        tokenDecimals: 6,
        token: {} as any,
      },
    ];

    vi.spyOn(globalThis, 'fetch' as any).mockResolvedValue({
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
    expect(thrown).not.toBe(undefined);
    expect(thrown!.message).toContain('GraphQL errors');
  });
});
