import { expect } from 'chai';
import http from 'http';

import { assert } from '@hyperlane-xyz/utils';

import { isMissingSelectorCallException } from '../../utils/contract.js';

import { HyperlaneSmartProvider } from './SmartProvider.js';

const CHAIN_ID = 1;
const FALLBACK_STAGGER_MS = 50;
const CALL_PARAMS = { to: '0x' + '11'.repeat(20), data: '0x12345678' };

const EthMethod = {
  ChainId: 'eth_chainId',
  Call: 'eth_call',
} as const;

const Behavior = {
  Hang: 'hang',
  Empty: 'empty',
  Data: 'data',
} as const;
type Behavior = (typeof Behavior)[keyof typeof Behavior];

const DATA_RESULT = '0x' + '00'.repeat(31) + '01';

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

async function startServer(
  callBehavior: Behavior,
  sockets: Set<http.ServerResponse>,
): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
      assertRequest(body);
      const reply = (result: string) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
      };
      if (body.method === EthMethod.ChainId) {
        reply('0x' + CHAIN_ID.toString(16));
        return;
      }
      if (body.method !== EthMethod.Call) {
        res.statusCode = 500;
        res.end();
        return;
      }
      switch (callBehavior) {
        case Behavior.Hang:
          sockets.add(res);
          return;
        case Behavior.Empty:
          reply('0x');
          return;
        case Behavior.Data:
          reply(DATA_RESULT);
          return;
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object', 'Server not listening');
  return { server, url: `http://127.0.0.1:${address.port}` };
}

function assertRequest(body: unknown): asserts body is JsonRpcRequest {
  if (!isJsonRpcRequest(body)) throw new Error('Unexpected JSON-RPC body');
}

describe('HyperlaneSmartProvider empty response with a hanging provider', function () {
  this.timeout(10_000);

  const servers: http.Server[] = [];
  const hanging = new Set<http.ServerResponse>();

  async function makeProvider(
    hangBehavior: Behavior,
    otherBehavior: Behavior,
  ): Promise<HyperlaneSmartProvider> {
    const a = await startServer(hangBehavior, hanging);
    const b = await startServer(otherBehavior, hanging);
    servers.push(a.server, b.server);
    return new HyperlaneSmartProvider(
      { chainId: CHAIN_ID, name: 'test' },
      [{ http: a.url }, { http: b.url }],
      [],
      { fallbackStaggerMs: FALLBACK_STAGGER_MS },
    );
  }

  afterEach(async () => {
    for (const res of hanging) res.destroy();
    hanging.clear();
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

  it('classifies an empty eth_call as a missing selector', async () => {
    const provider = await makeProvider(Behavior.Hang, Behavior.Empty);

    let thrown: unknown;
    try {
      await provider.call(CALL_PARAMS);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).to.be.instanceOf(Error);
    expect(isMissingSelectorCallException(thrown)).to.equal(true);
  });

  it('resolves when the other provider returns data', async () => {
    const provider = await makeProvider(Behavior.Hang, Behavior.Data);

    expect(await provider.call(CALL_PARAMS)).to.equal(DATA_RESULT);
  });
});
