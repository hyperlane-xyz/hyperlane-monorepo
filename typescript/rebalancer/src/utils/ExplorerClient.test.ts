import { expect, type MockInstance } from 'vitest';
import { pino } from 'pino';

import { addressToByteHexString, ProtocolType } from '@hyperlane-xyz/utils';

import { ExplorerClient } from './ExplorerClient.js';

const testLogger = pino({ level: 'silent' });

function getFetchBody(
  stub: MockInstance<typeof fetch>,
  callIdx = 0,
): { variables: Record<string, unknown> } {
  const body = stub.mock.calls[callIdx]?.[1]?.body;
  if (typeof body !== 'string') {
    throw new Error('expected fetch call to have a string body');
  }
  return JSON.parse(body);
}

describe('ExplorerClient', () => {
  let fetchStub: MockInstance<typeof fetch>;

  beforeEach(() => {
    fetchStub = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { message_view: [] } }), {
        status: 200,
      }),
    );
  });

  afterEach(() => {
    fetchStub.mockRestore();
  });

  describe('getInflightUserTransfers address encoding', () => {
    it('encodes EVM router addresses as 20-byte hex bytea', async () => {
      const evmAddr = '0x5a0e13290ec57f5e9031d01d03c6a40029cc24ea';
      const getProtocol = vi.fn().mockReturnValue(ProtocolType.Ethereum);
      const client = new ExplorerClient('https://explorer.test', getProtocol);

      await client.getInflightUserTransfers(
        {
          routersByDomain: { 1: evmAddr },
          excludeTxSenders: [],
        },
        testLogger,
      );

      expect(fetchStub).toHaveBeenCalledOnce();
      const body = getFetchBody(fetchStub);
      expect(body.variables.senders).toEqual([
        '\\x5a0e13290ec57f5e9031d01d03c6a40029cc24ea',
      ]);
      expect(body.variables.recipients).toEqual([
        '\\x5a0e13290ec57f5e9031d01d03c6a40029cc24ea',
      ]);
    });

    it('encodes Solana router addresses as 32-byte hex bytea', async () => {
      const solAddr = 'E5rVV8zXwtc4TKGypCJvSBaYbgxa4XaYg5MS6N9QGdeo';
      const getProtocol = vi.fn().mockReturnValue(ProtocolType.Sealevel);
      const client = new ExplorerClient('https://explorer.test', getProtocol);

      await client.getInflightUserTransfers(
        {
          routersByDomain: { 1399811149: solAddr },
          excludeTxSenders: [],
        },
        testLogger,
      );

      expect(fetchStub).toHaveBeenCalledOnce();
      const body = getFetchBody(fetchStub);
      const expectedHex = addressToByteHexString(
        solAddr,
        ProtocolType.Sealevel,
      );
      const expectedBytea = expectedHex.replace(/^0x/i, '\\x').toLowerCase();
      expect(body.variables.senders).toEqual([expectedBytea]);
      expect(body.variables.recipients).toEqual([expectedBytea]);
      // 32 bytes = 64 hex chars + 2-char \\x prefix
      expect(expectedBytea.length).toBe(66);
    });

    it('encodes Starknet router addresses as hex bytea', async () => {
      const starkAddr =
        '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7';
      const getProtocol = vi.fn().mockReturnValue(ProtocolType.Starknet);
      const client = new ExplorerClient('https://explorer.test', getProtocol);

      await client.getInflightUserTransfers(
        {
          routersByDomain: { 4009: starkAddr },
          excludeTxSenders: [],
        },
        testLogger,
      );

      expect(fetchStub).toHaveBeenCalledOnce();
      const body = getFetchBody(fetchStub);
      const expectedHex = addressToByteHexString(
        starkAddr,
        ProtocolType.Starknet,
      );
      const expectedBytea = expectedHex.replace(/^0x/i, '\\x').toLowerCase();
      expect(body.variables.senders).toEqual([expectedBytea]);
    });

    it('encodes mixed EVM+Solana routersByDomain correctly', async () => {
      const evmAddr = '0x5a0e13290ec57f5e9031d01d03c6a40029cc24ea';
      const solAddr = 'E5rVV8zXwtc4TKGypCJvSBaYbgxa4XaYg5MS6N9QGdeo';

      const getProtocol = vi.fn().mockImplementation((domain: number) => {
        if (domain === 1) return ProtocolType.Ethereum;
        if (domain === 1399811149) return ProtocolType.Sealevel;
        return ProtocolType.Ethereum;
      });
      const client = new ExplorerClient('https://explorer.test', getProtocol);

      await client.getInflightUserTransfers(
        {
          routersByDomain: { 1: evmAddr, 1399811149: solAddr },
          excludeTxSenders: [],
        },
        testLogger,
      );

      expect(fetchStub).toHaveBeenCalledOnce();
      const body = getFetchBody(fetchStub);

      const expectedEvmBytea = '\\x5a0e13290ec57f5e9031d01d03c6a40029cc24ea';
      const expectedSolHex = addressToByteHexString(
        solAddr,
        ProtocolType.Sealevel,
      );
      const expectedSolBytea = expectedSolHex
        .replace(/^0x/i, '\\x')
        .toLowerCase();

      expect(body.variables.senders).toContain(expectedEvmBytea);
      expect(body.variables.senders).toContain(expectedSolBytea);
      expect(body.variables.recipients).toContain(expectedEvmBytea);
      expect(body.variables.recipients).toContain(expectedSolBytea);
    });

    it('handles empty routersByDomain gracefully', async () => {
      const getProtocol = vi.fn().mockReturnValue(ProtocolType.Ethereum);
      const client = new ExplorerClient('https://explorer.test', getProtocol);

      await client.getInflightUserTransfers(
        {
          routersByDomain: {},
          excludeTxSenders: [],
        },
        testLogger,
      );

      expect(fetchStub).toHaveBeenCalledOnce();
      const body = getFetchBody(fetchStub);
      expect(body.variables.senders).toEqual([]);
      expect(body.variables.recipients).toEqual([]);
      expect(body.variables.originDomains).toEqual([]);
    });
  });

  describe('getInflightRebalanceActions address encoding', () => {
    it('encodes mixed EVM+Solana routersByDomain in originTxRecipients', async () => {
      const evmAddr = '0x5a0e13290ec57f5e9031d01d03c6a40029cc24ea';
      const solAddr = 'E5rVV8zXwtc4TKGypCJvSBaYbgxa4XaYg5MS6N9QGdeo';
      const bridgeAddr = '0x1234567890abcdef1234567890abcdef12345678';
      const rebalancerAddr = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

      const getProtocol = vi.fn().mockImplementation((domain: number) => {
        if (domain === 1) return ProtocolType.Ethereum;
        if (domain === 1399811149) return ProtocolType.Sealevel;
        return ProtocolType.Ethereum;
      });
      const client = new ExplorerClient('https://explorer.test', getProtocol);

      await client.getInflightRebalanceActions(
        {
          bridges: [bridgeAddr],
          routersByDomain: { 1: evmAddr, 1399811149: solAddr },
          rebalancerAddress: rebalancerAddr,
        },
        testLogger,
      );

      expect(fetchStub).toHaveBeenCalledOnce();
      const body = getFetchBody(fetchStub);

      // bridges encoded as EVM bytea (20-byte)
      expect(body.variables.senders).toEqual([
        '\\x1234567890abcdef1234567890abcdef12345678',
      ]);
      expect(body.variables.recipients).toEqual([
        '\\x1234567890abcdef1234567890abcdef12345678',
      ]);
      // rebalancer encoded as EVM bytea
      expect(body.variables.txSenders).toEqual([
        '\\xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      ]);

      // originTxRecipients: EVM router as 20-byte bytea, Solana as 32-byte bytea
      const expectedEvmBytea = '\\x5a0e13290ec57f5e9031d01d03c6a40029cc24ea';
      const expectedSolHex = addressToByteHexString(
        solAddr,
        ProtocolType.Sealevel,
      );
      const expectedSolBytea = expectedSolHex
        .replace(/^0x/i, '\\x')
        .toLowerCase();

      expect(body.variables.originTxRecipients).toContain(expectedEvmBytea);
      expect(body.variables.originTxRecipients).toContain(expectedSolBytea);
      // 32 bytes = 64 hex chars + 2-char \\x prefix
      expect(expectedSolBytea.length).toBe(66);
    });
  });

  describe('hasUndeliveredRebalance post-query validation', () => {
    it('validates non-EVM router addresses correctly in post-query filter', async () => {
      const solAddr = 'E5rVV8zXwtc4TKGypCJvSBaYbgxa4XaYg5MS6N9QGdeo';
      const solHex = addressToByteHexString(solAddr, ProtocolType.Sealevel);
      const solBytea = solHex.replace(/^0x/i, '\\x').toLowerCase();

      const bridgeAddr = '0x1234567890abcdef1234567890abcdef12345678';
      const txSenderAddr = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

      const getProtocol = vi.fn().mockReturnValue(ProtocolType.Sealevel);
      const client = new ExplorerClient('https://explorer.test', getProtocol);

      fetchStub.mockResolvedValue(
        new Response(
          JSON.stringify({
            data: {
              message_view: [
                {
                  msg_id:
                    '\\xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                  origin_domain_id: 1399811149,
                  destination_domain_id: 1,
                  sender: '\\x1234567890abcdef1234567890abcdef12345678',
                  recipient: '\\x1234567890abcdef1234567890abcdef12345678',
                  origin_tx_hash:
                    '\\xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                  origin_tx_sender:
                    '\\xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
                  origin_tx_recipient: solBytea,
                  is_delivered: false,
                },
              ],
            },
          }),
          { status: 200 },
        ),
      );

      const result = await client.hasUndeliveredRebalance(
        {
          bridges: [bridgeAddr],
          routersByDomain: { 1399811149: solAddr },
          txSender: txSenderAddr,
        },
        testLogger,
      );

      expect(result).toBe(true);
    });

    it('returns false when origin_tx_recipient does not match expected router', async () => {
      const evmAddr = '0x5a0e13290ec57f5e9031d01d03c6a40029cc24ea';
      const wrongRouter = '0xffffffffffffffffffffffffffffffffffffffff';

      const getProtocol = vi.fn().mockReturnValue(ProtocolType.Ethereum);
      const client = new ExplorerClient('https://explorer.test', getProtocol);

      fetchStub.mockResolvedValue(
        new Response(
          JSON.stringify({
            data: {
              message_view: [
                {
                  msg_id:
                    '\\xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                  origin_domain_id: 1,
                  destination_domain_id: 137,
                  sender: '\\x1234567890abcdef1234567890abcdef12345678',
                  recipient: '\\x1234567890abcdef1234567890abcdef12345678',
                  origin_tx_hash:
                    '\\xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                  origin_tx_sender:
                    '\\xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
                  origin_tx_recipient: '\\x' + wrongRouter.slice(2),
                  is_delivered: false,
                },
              ],
            },
          }),
          { status: 200 },
        ),
      );

      const result = await client.hasUndeliveredRebalance(
        {
          bridges: ['0x1234567890abcdef1234567890abcdef12345678'],
          routersByDomain: { 1: evmAddr },
          txSender: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        },
        testLogger,
      );

      expect(result).toBe(false);
    });

    it('validates EVM router addresses correctly in post-query filter', async () => {
      const evmAddr = '0x5a0e13290ec57f5e9031d01d03c6a40029cc24ea';

      const getProtocol = vi.fn().mockReturnValue(ProtocolType.Ethereum);
      const client = new ExplorerClient('https://explorer.test', getProtocol);

      fetchStub.mockResolvedValue(
        new Response(
          JSON.stringify({
            data: {
              message_view: [
                {
                  msg_id:
                    '\\xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                  origin_domain_id: 1,
                  destination_domain_id: 137,
                  sender: '\\x1234567890abcdef1234567890abcdef12345678',
                  recipient: '\\x1234567890abcdef1234567890abcdef12345678',
                  origin_tx_hash:
                    '\\xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                  origin_tx_sender:
                    '\\xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
                  origin_tx_recipient:
                    '\\x5a0e13290ec57f5e9031d01d03c6a40029cc24ea',
                  is_delivered: false,
                },
              ],
            },
          }),
          { status: 200 },
        ),
      );

      const result = await client.hasUndeliveredRebalance(
        {
          bridges: ['0x1234567890abcdef1234567890abcdef12345678'],
          routersByDomain: { 1: evmAddr },
          txSender: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        },
        testLogger,
      );

      expect(result).toBe(true);
    });
  });

  describe('error handling', () => {
    it('throws on non-200 response from explorer', async () => {
      const getProtocol = vi.fn().mockReturnValue(ProtocolType.Ethereum);
      const client = new ExplorerClient('https://explorer.test', getProtocol);

      fetchStub.mockResolvedValue(
        new Response(
          JSON.stringify({
            errors: [{ message: 'Internal Server Error' }],
          }),
          { status: 500 },
        ),
      );

      await expect(
        client.hasUndeliveredRebalance(
          {
            bridges: ['0x1234567890abcdef1234567890abcdef12345678'],
            routersByDomain: {
              1: '0x5a0e13290ec57f5e9031d01d03c6a40029cc24ea',
            },
            txSender: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
          },
          testLogger,
        ),
      ).rejects.toThrow('Explorer query failed: 500');
    });
  });
});
