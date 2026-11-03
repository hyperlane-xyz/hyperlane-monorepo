import { expect } from 'chai';
import http from 'http';

import { assert } from '@hyperlane-xyz/utils';

import { HyperlaneSmartProvider } from '../providers/SmartProvider/SmartProvider.js';

import { isMissingSelectorCallException } from './contract.js';

const CHAIN_ID = 1;
const FALLBACK_STAGGER_MS = 50;
const CALL_PARAMS = { to: '0x' + '11'.repeat(20), data: '0x12345678' };

const EthMethod = {
  ChainId: 'eth_chainId',
  Call: 'eth_call',
} as const;

const CallBehavior = {
  Http500: 'http500',
  HeaderNotFound: 'headerNotFound',
  DestroySocket: 'destroySocket',
  RateLimit: 'rateLimit',
  RevertCode3: 'revertCode3',
  ExecutionReverted: 'executionReverted',
  EmptyResult: 'emptyResult',
} as const;
type CallBehavior = (typeof CallBehavior)[keyof typeof CallBehavior];

interface JsonRpcRequest {
  id: number;
  method: string;
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'number' &&
    'method' in value &&
    typeof value.method === 'string'
  );
}

function assertRequest(body: unknown): asserts body is JsonRpcRequest {
  if (!isJsonRpcRequest(body)) throw new Error('Unexpected JSON-RPC body');
}

async function startServer(
  callBehavior: CallBehavior,
): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
      assertRequest(body);
      res.setHeader('content-type', 'application/json');
      const reply = (payload: Record<string, unknown>) =>
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...payload }));
      const replyError = (code: number, message: string, data?: string) =>
        reply({ error: { code, message, data } });

      if (body.method === EthMethod.ChainId) {
        reply({ result: '0x' + CHAIN_ID.toString(16) });
        return;
      }
      assert(body.method === EthMethod.Call, `Unexpected ${body.method}`);
      switch (callBehavior) {
        case CallBehavior.Http500:
          res.statusCode = 500;
          res.end('Internal Server Error');
          return;
        case CallBehavior.HeaderNotFound:
          replyError(-32000, 'header not found');
          return;
        case CallBehavior.DestroySocket:
          req.socket.destroy();
          return;
        case CallBehavior.RateLimit:
          res.statusCode = 429;
          res.end('Too Many Requests');
          return;
        case CallBehavior.RevertCode3:
          replyError(3, 'execution reverted', '0x');
          return;
        case CallBehavior.ExecutionReverted:
          replyError(-32000, 'execution reverted');
          return;
        case CallBehavior.EmptyResult:
          reply({ result: '0x' });
          return;
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object', 'Server not listening');
  return { server, url: `http://127.0.0.1:${address.port}` };
}

interface Case {
  name: string;
  behavior: CallBehavior;
  expectedMissingSelector: boolean;
}

const cases: Case[] = [
  {
    name: 'HTTP 500',
    behavior: CallBehavior.Http500,
    expectedMissingSelector: false,
  },
  {
    name: 'JSON-RPC -32000 header not found',
    behavior: CallBehavior.HeaderNotFound,
    expectedMissingSelector: false,
  },
  {
    name: 'dropped connection',
    behavior: CallBehavior.DestroySocket,
    expectedMissingSelector: false,
  },
  {
    name: 'HTTP 429 rate limit',
    behavior: CallBehavior.RateLimit,
    expectedMissingSelector: false,
  },
  {
    name: 'JSON-RPC code 3 revert with empty data',
    behavior: CallBehavior.RevertCode3,
    expectedMissingSelector: true,
  },
  {
    name: 'JSON-RPC -32000 execution reverted',
    behavior: CallBehavior.ExecutionReverted,
    expectedMissingSelector: true,
  },
  {
    name: 'empty eth_call result',
    behavior: CallBehavior.EmptyResult,
    expectedMissingSelector: true,
  },
];

describe('isMissingSelectorCallException against a real SmartProvider', function () {
  this.timeout(20_000);

  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  });

  for (const c of cases) {
    it(`returns ${c.expectedMissingSelector} for ${c.name}`, async () => {
      const a = await startServer(c.behavior);
      const b = await startServer(c.behavior);
      servers.push(a.server, b.server);
      const provider = new HyperlaneSmartProvider(
        { chainId: CHAIN_ID, name: 'test' },
        [{ http: a.url }, { http: b.url }],
        [],
        { fallbackStaggerMs: FALLBACK_STAGGER_MS, maxRetries: 1 },
      );

      let thrown: unknown;
      try {
        await provider.call(CALL_PARAMS);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).to.be.instanceOf(Error);
      expect(isMissingSelectorCallException(thrown)).to.equal(
        c.expectedMissingSelector,
      );
    });
  }
});
