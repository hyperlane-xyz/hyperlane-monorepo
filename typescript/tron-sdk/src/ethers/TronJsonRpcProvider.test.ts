import { once } from 'node:events';
import { createServer } from 'node:http';

import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { utils } from 'ethers';
import { TronWeb } from 'tronweb';

import { assert } from '@hyperlane-xyz/utils';

import { TRON_EMPTY_ADDRESS, toTronHex } from '../utils/index.js';
import { TronJsonRpcProvider } from './TronJsonRpcProvider.js';

chai.use(chaiAsPromised);

const CONTRACT = '0x19335987d77120c462ca7df51cf29f68a38e6d6c';
const CONTRACT_HEX = '4119335987d77120c462ca7df51cf29f68a38e6d6c';
const SELECTOR = '0x7f5a7c7b';
// Real mainnet EOA and its base58 form (TRH7XVrd…LXaBG).
const EOA = '0xa7eccdb9be08178f896c26b7bbd8c3d4e844d9ba';
const EOA_BASE58 = 'TRH7XVrdZk2P5DA8aVaufMNkUZBd8LXaBG';

interface CapturedRequest {
  url: string;
  payload: Record<string, unknown>;
  method?: string;
}

type Captured = { value?: CapturedRequest; calls: number };

/** Subset of the raw constant-call response the provider reads. */
interface ConstantCallResponse {
  transaction?: { ret?: Array<{ ret?: string; contractRet?: string }> };
  result?: { result?: boolean; message?: string };
  constant_result?: string[];
}

/** Subset of the raw `wallet/getaccount` response the provider reads. */
interface AccountResponse {
  Error?: string;
  address?: string;
  balance?: number;
  create_time?: number;
  type?: string;
}

type StubResponse =
  | ConstantCallResponse
  | AccountResponse
  | { block_header?: { raw_data?: { number?: unknown } } };

// Deliberately looser than TronWeb's optimistic `request<T>` declaration: the
// transport can answer with no body at all, and the provider guards for it.
type RequestImpl = (
  url: string,
  payload: Record<string, unknown>,
  method?: string,
) => Promise<unknown>;

/** Minimal TronWeb surface the provider invokes on the injected instance. */
interface TronWebStub {
  address: {
    toHex: (address: string) => string;
    fromHex: (address: string) => string;
  };
  toUtf8: (hex: string) => string;
  fullNode: {
    request: RequestImpl;
  };
  solidityNode: {
    instance: {
      request: (config: {
        url: string;
        data: Record<string, unknown>;
        method?: string;
      }) => Promise<{ data: unknown }>;
    };
  };
}

// Shared real TronWeb for the pure helpers (address/utf8 conversion) that the
// provider invokes on the injected instance; only fullNode.request is stubbed.
const realTronWeb = new TronWeb({ fullHost: 'https://api.trongrid.io' });

function makeProvider(maxRetries = 1): TronJsonRpcProvider {
  return new TronJsonRpcProvider(
    'https://node.example.com/jsonrpc',
    728126428,
    maxRetries,
    0,
  );
}

/**
 * Injects a tronWeb double whose fullNode.request runs `request`. Delegates
 * address/utf8 helpers to a real TronWeb.
 */
function stubFullNodeRequest(
  provider: TronJsonRpcProvider,
  request: RequestImpl,
): void {
  const tronWeb: TronWebStub = {
    address: {
      toHex: (a: string) => realTronWeb.address.toHex(a),
      fromHex: (a: string) => realTronWeb.address.fromHex(a),
    },
    toUtf8: (hex: string) => realTronWeb.toUtf8(hex),
    fullNode: { request },
    solidityNode: {
      instance: {
        request: async ({ url, data, method }) => ({
          data: await request(url, data, method),
        }),
      },
    },
  };
  // CAST: inject the minimal fullNode double into the provider's private
  // `tronWeb` field.
  (provider as unknown as { tronWeb: TronWebStub }).tronWeb = tronWeb;
}

/**
 * Injects a tronWeb double whose fullNode.request returns `response` (and
 * records the request).
 */
function stubFullNode(
  provider: TronJsonRpcProvider,
  response: StubResponse,
  captured?: { value?: CapturedRequest; calls: number },
): void {
  stubFullNodeRequest(
    provider,
    async (url: string, payload: Record<string, unknown>, method?: string) => {
      if (captured) {
        captured.value = { url, payload, method };
        captured.calls += 1;
      }
      return response;
    },
  );
}

type SendImpl = (method: string, params: unknown[]) => Promise<unknown>;

function stubSend(provider: TronJsonRpcProvider, impl: SendImpl): void {
  provider.send = impl;
}

describe('TronJsonRpcProvider finalized block', () => {
  it('uses the solidity endpoint and returns the solidified height', async () => {
    const provider = makeProvider();
    const captured: Captured = { calls: 0 };
    stubFullNode(
      provider,
      { block_header: { raw_data: { number: 123 } } },
      captured,
    );
    expect(await provider.getFinalizedBlockNumber()).to.equal(123);
    expect(captured.value).to.deep.equal({
      url: 'walletsolidity/getnowblock',
      payload: {},
      method: 'POST',
    });
  });

  it('sends an empty JSON object through the configured native transport', async () => {
    let body = '';
    let path: string | undefined;
    let method: string | undefined;
    let header: string | string[] | undefined;
    const server = createServer((request, response) => {
      path = request.url;
      method = request.method;
      header = request.headers['x-finality-test'];
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        body += chunk;
      });
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        if (body !== '{}') {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: 'JSON object required' }));
          return;
        }
        response.end(
          JSON.stringify({ block_header: { raw_data: { number: 123 } } }),
        );
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(
      address && typeof address === 'object',
      'Expected listening test server',
    );
    const provider = new TronJsonRpcProvider(
      `http://127.0.0.1:${address.port}/v2/test/jsonrpc?custom_rpc_header=x-finality-test:preserved`,
      728126428,
    );
    try {
      expect(await provider.getFinalizedBlockNumber()).to.equal(123);
      expect(body).to.equal('{}');
      expect(path).to.equal('/v2/test/walletsolidity/getnowblock');
      expect(method).to.equal('POST');
      expect(header).to.equal('preserved');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('rejects missing or malformed finality and propagates transport failures', async () => {
    for (const response of [
      {},
      { block_header: {} },
      { block_header: { raw_data: { number: '123' } } },
      { block_header: { raw_data: { number: -1 } } },
      { block_header: { raw_data: { number: Number.MAX_SAFE_INTEGER + 1 } } },
    ]) {
      const provider = makeProvider();
      stubFullNode(provider, response);
      await expect(provider.getFinalizedBlockNumber()).to.be.rejected;
    }
    const provider = makeProvider();
    stubFullNodeRequest(provider, async () => {
      throw new Error('finality RPC timeout');
    });
    await expect(provider.getFinalizedBlockNumber()).to.be.rejectedWith(
      'finality RPC timeout',
    );
  });
});

// Raw node/transport error as it leaves ethers' `send`, BEFORE `checkError`
// wraps it. Routing these through the real provider (rather than hand-building
// the synthetic CALL_EXCEPTION) exercises the exact shape production sees: for
// the `call` method ethers wraps every failure into a top-level CALL_EXCEPTION
// (message "missing revert data in call exception", data "0x") nesting this
// original error under `.error`.
function nodeError(message: string, code: string | number): Error {
  const error = new Error(message);
  Object.assign(error, { code });
  return error;
}

// A reasonless Tron revert (the missing-selector case): the node returns an
// "execution reverted" failure that ethers classifies as SERVER_ERROR.
const REVERT_ERROR = nodeError(
  'execution reverted',
  utils.Logger.errors.SERVER_ERROR,
);
// A revert surfaced only through the JSON-RPC revert code, no revert message.
const REVERT_CODE_ERROR = nodeError('execution failed', 3);
// A genuine connectivity failure — same nested code family as REVERT_ERROR but
// no revert indicator.
const TRANSPORT_ERROR = nodeError(
  'bad response (status=503)',
  utils.Logger.errors.SERVER_ERROR,
);
const TIMEOUT_ERROR = nodeError('timeout', utils.Logger.errors.TIMEOUT);
// A node that simply doesn't answer eth_call: a clean numeric JSON-RPC error
// with no revert indicator, which must fall back to native like any transport
// failure rather than being mistaken for a revert.
const METHOD_NOT_FOUND_ERROR = nodeError(
  'the method eth_call does not exist/is not available',
  -32601,
);

function throwingSend(error: Error): SendImpl {
  return async () => {
    throw error;
  };
}

function throwingRequest(error: Error): RequestImpl {
  return async () => {
    throw error;
  };
}

// `wallet/getaccount` bodies as mainnet returns them for `visible: true`. A
// contract account omits `create_time` entirely, which is why activation keys
// off the body being non-empty rather than off that field.
const ACTIVE_EOA_ACCOUNT: AccountResponse = {
  address: EOA_BASE58,
  balance: 2_543_000_000,
  create_time: 1_773_619_200_000,
};

const ACTIVE_CONTRACT_ACCOUNT: AccountResponse = {
  address: 'TCGTQhMDW82v8Ls93zVeq9pFV2JVkdxDuq',
  balance: 0,
  type: 'Contract',
};

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  let thrown: unknown;
  try {
    await promise;
  } catch (error: unknown) {
    thrown = error;
  }
  expect(thrown, 'expected the call to reject').to.exist;
  return thrown;
}

describe('TronJsonRpcProvider finalized contract calls', () => {
  it('uses only the Solidity endpoint for an explicit finalized read', async () => {
    const provider = makeProvider();
    let jsonRpcCalls = 0;
    stubSend(provider, async () => {
      jsonRpcCalls++;
      return '0xdead';
    });
    const captured: Captured = { calls: 0 };
    stubFullNode(
      provider,
      {
        result: { result: true },
        constant_result: ['00ff'],
        transaction: { ret: [{}] },
      },
      captured,
    );
    expect(
      await provider.call({ to: CONTRACT, data: SELECTOR }, 'finalized'),
    ).to.equal('0x00ff');
    expect(jsonRpcCalls).to.equal(0);
    expect(captured.value?.url).to.equal(
      'walletsolidity/triggerconstantcontract',
    );
    expect(captured.value?.payload['owner_address']).to.equal(
      toTronHex(realTronWeb, TRON_EMPTY_ADDRESS),
    );
    expect(captured.value?.payload['data']).to.equal(SELECTOR.slice(2));
  });

  it('preserves the configured path and authentication on a real finalized HTTP call', async () => {
    let path: string | undefined;
    let header: string | string[] | undefined;
    let body = '';
    const server = createServer((request, response) => {
      path = request.url;
      header = request.headers['x-finality-test'];
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        body += chunk;
      });
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            result: { result: true },
            constant_result: ['00ff'],
            transaction: { ret: [{ ret: 'SUCESS', contractRet: 'SUCCESS' }] },
          }),
        );
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(
      address && typeof address === 'object',
      'Expected listening test server',
    );
    const provider = new TronJsonRpcProvider(
      `http://127.0.0.1:${address.port}/v2/test/jsonrpc?custom_rpc_header=x-finality-test:preserved`,
      728126428,
    );
    try {
      expect(
        await provider.call({ to: CONTRACT, data: SELECTOR }, 'finalized'),
      ).to.equal('0x00ff');
      expect(path).to.equal('/v2/test/walletsolidity/triggerconstantcontract');
      expect(header).to.equal('preserved');
      expect(JSON.parse(body)).to.include({
        contract_address: CONTRACT_HEX,
        owner_address: toTronHex(realTronWeb, TRON_EMPTY_ADDRESS),
        data: SELECTOR.slice(2),
        visible: false,
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('does not route numeric historical reads through latest or Solidity state', async () => {
    const provider = makeProvider();
    let requestedTag: unknown;
    stubSend(provider, async (_method, params) => {
      requestedTag = params[1];
      throw new Error('historical unsupported');
    });
    const captured: Captured = { calls: 0 };
    stubFullNode(
      provider,
      {
        result: { result: true },
        constant_result: ['00'],
        transaction: { ret: [{}] },
      },
      captured,
    );
    await expect(provider.call({ to: CONTRACT, data: SELECTOR }, 123)).to.be
      .rejected;
    expect(requestedTag).to.equal('0x7b');
    expect(captured.calls).to.equal(0);
  });

  it('propagates a Solidity transport failure without an unconfirmed fallback', async () => {
    const provider = makeProvider();
    let jsonRpcCalls = 0;
    stubSend(provider, async () => {
      jsonRpcCalls++;
      return '0x00';
    });
    stubFullNodeRequest(provider, throwingRequest(TIMEOUT_ERROR));
    await expect(
      provider.call({ to: CONTRACT, data: SELECTOR }, 'finalized'),
    ).to.be.rejectedWith('timeout');
    expect(jsonRpcCalls).to.equal(0);
  });

  it('rejects explicit VM failure even when the API reports success', async () => {
    for (const outcome of [
      { ret: 'FAILED' },
      { contractRet: 'REVERT' },
      { contractRet: 'OUT_OF_ENERGY' },
    ]) {
      const provider = makeProvider();
      stubFullNode(provider, {
        result: { result: true },
        constant_result: ['abcd'],
        transaction: { ret: [outcome] },
      });
      const error = await rejectionOf(
        provider.call({ to: CONTRACT, data: SELECTOR }, 'finalized'),
      );
      expect(error).to.have.property(
        'code',
        utils.Logger.errors.CALL_EXCEPTION,
      );
      expect(error).to.have.property('data', '0xabcd');
    }
  });

  it('preserves reasonless executed-revert errors', async () => {
    const provider = makeProvider();
    stubFullNode(provider, {
      result: { result: false },
      constant_result: [''],
    });
    const error = await rejectionOf(
      provider.call({ to: CONTRACT, data: SELECTOR }, 'finalized'),
    );
    expect(error).to.have.property('code', utils.Logger.errors.CALL_EXCEPTION);
    expect(error).to.have.property('data', '0x');
  });

  it('fails closed on missing, malformed, or unproven finalized return data', async () => {
    for (const response of [
      undefined,
      null,
      {},
      { result: { result: true }, constant_result: ['00'] },
      { result: { result: true }, transaction: { ret: [{}] } },
      {
        result: { result: true },
        constant_result: ['zz'],
        transaction: { ret: [{}] },
      },
      {
        result: { result: true },
        constant_result: ['0'],
        transaction: { ret: [{}] },
      },
      {
        result: { result: true },
        constant_result: ['00', '11'],
        transaction: { ret: [{}] },
      },
      {
        result: { result: true },
        constant_result: ['00'],
        transaction: { ret: [] },
      },
      {
        result: { result: 'true' },
        constant_result: ['00'],
        transaction: { ret: [{}] },
      },
    ]) {
      const provider = makeProvider();
      stubFullNodeRequest(provider, async () => response);
      await expect(provider.call({ to: CONTRACT, data: SELECTOR }, 'finalized'))
        .to.be.rejected;
    }
  });
});

describe('TronJsonRpcProvider', () => {
  describe('perform (eth_call-first with native fallback)', () => {
    it('returns the eth_call result without touching the native endpoint', async () => {
      const provider = makeProvider();
      stubSend(provider, async () => '0x1234');
      const captured: Captured = { calls: 0 };
      stubFullNode(
        provider,
        { result: { result: true }, constant_result: ['dead'] },
        captured,
      );

      const result = await provider.call({ to: CONTRACT, data: SELECTOR });

      expect(result).to.equal('0x1234');
      expect(captured.calls).to.equal(0);
    });

    it('rethrows a reverting read (revert message) without touching native', async () => {
      const provider = makeProvider();
      stubSend(provider, throwingSend(REVERT_ERROR));
      const captured: Captured = { calls: 0 };
      stubFullNode(
        provider,
        { result: { result: true }, constant_result: ['dead'] },
        captured,
      );

      // ethers wraps the revert as a top-level CALL_EXCEPTION (data="0x"), which
      // the SDK's missing-selector detection recognizes; it must propagate as-is
      // and must NOT fall back to native.
      const thrown = await rejectionOf(
        provider.call({ to: CONTRACT, data: SELECTOR }),
      );
      expect(thrown).to.have.property(
        'code',
        utils.Logger.errors.CALL_EXCEPTION,
      );
      expect(thrown).to.have.property('data', '0x');
      expect(captured.calls).to.equal(0);
    });

    it('rethrows a reverting read (JSON-RPC revert code) without touching native', async () => {
      const provider = makeProvider();
      stubSend(provider, throwingSend(REVERT_CODE_ERROR));
      const captured: Captured = { calls: 0 };
      stubFullNode(
        provider,
        { result: { result: true }, constant_result: ['dead'] },
        captured,
      );

      const thrown = await rejectionOf(
        provider.call({ to: CONTRACT, data: SELECTOR }),
      );
      expect(thrown).to.have.property(
        'code',
        utils.Logger.errors.CALL_EXCEPTION,
      );
      expect(captured.calls).to.equal(0);
    });

    it('falls back to native on a server-error transport failure', async () => {
      const provider = makeProvider();
      stubSend(provider, throwingSend(TRANSPORT_ERROR));
      const captured: Captured = { calls: 0 };
      stubFullNode(
        provider,
        { result: { result: true }, constant_result: ['00ff'] },
        captured,
      );

      const result = await provider.call({ to: CONTRACT, data: SELECTOR });

      expect(result).to.equal('0x00ff');
      expect(captured.calls).to.equal(1);
    });

    it('falls back to native on a timeout transport failure', async () => {
      const provider = makeProvider();
      stubSend(provider, throwingSend(TIMEOUT_ERROR));
      const captured: Captured = { calls: 0 };
      stubFullNode(
        provider,
        { result: { result: true }, constant_result: ['00ff'] },
        captured,
      );

      const result = await provider.call({ to: CONTRACT, data: SELECTOR });

      expect(result).to.equal('0x00ff');
      expect(captured.calls).to.equal(1);
    });

    it('falls back to native when the node does not answer eth_call (-32601)', async () => {
      const provider = makeProvider();
      stubSend(provider, throwingSend(METHOD_NOT_FOUND_ERROR));
      const captured: Captured = { calls: 0 };
      stubFullNode(
        provider,
        { result: { result: true }, constant_result: ['00ff'] },
        captured,
      );

      const result = await provider.call({ to: CONTRACT, data: SELECTOR });

      expect(result).to.equal('0x00ff');
      expect(captured.calls).to.equal(1);
    });
  });

  describe('native constant call (fallback path)', () => {
    // Force the fallback by making eth_call fail with a transport error.
    function fallbackProvider(): TronJsonRpcProvider {
      const provider = makeProvider();
      stubSend(provider, throwingSend(TRANSPORT_ERROR));
      return provider;
    }

    it('returns the decoded data and posts to the raw endpoint', async () => {
      const provider = fallbackProvider();
      const captured: Captured = { calls: 0 };
      stubFullNode(
        provider,
        { result: { result: true }, constant_result: ['00ff'] },
        captured,
      );

      const result = await provider.call({ to: CONTRACT, data: SELECTOR });

      expect(result).to.equal('0x00ff');
      expect(captured.value?.url).to.equal('wallet/triggerconstantcontract');
      expect(captured.value?.method).to.equal('post');
      expect(captured.value?.payload['contract_address']).to.equal(
        CONTRACT_HEX,
      );
      expect(captured.value?.payload['data']).to.equal('7f5a7c7b');
    });

    it('throws a CALL_EXCEPTION with 0x data for a reasonless revert (empty constant_result)', async () => {
      const provider = fallbackProvider();
      stubFullNode(provider, {
        result: {
          result: false,
          message: realTronWeb.fromUtf8('REVERT opcode executed'),
        },
        constant_result: [],
      });

      const thrown = await rejectionOf(
        provider.call({ to: CONTRACT, data: SELECTOR }),
      );

      expect(thrown).to.have.property(
        'code',
        utils.Logger.errors.CALL_EXCEPTION,
      );
      expect(thrown).to.have.property('data', '0x');
    });

    it('throws a CALL_EXCEPTION with 0x data for a reasonless revert (empty-string constant_result)', async () => {
      const provider = fallbackProvider();
      stubFullNode(provider, {
        result: { result: false },
        constant_result: [''],
      });

      const thrown = await rejectionOf(
        provider.call({ to: CONTRACT, data: SELECTOR }),
      );

      expect(thrown).to.have.property(
        'code',
        utils.Logger.errors.CALL_EXCEPTION,
      );
      expect(thrown).to.have.property('data', '0x');
    });

    it('throws a CALL_EXCEPTION carrying the revert data for a revert with data', async () => {
      const provider = fallbackProvider();
      // ABI-encoded Error(string) revert payload.
      const REVERT_DATA =
        '08c379a00000000000000000000000000000000000000000000000000000000000000020';
      stubFullNode(provider, {
        result: { result: false },
        constant_result: [REVERT_DATA],
      });

      const thrown = await rejectionOf(
        provider.call({ to: CONTRACT, data: SELECTOR }),
      );

      expect(thrown).to.have.property(
        'code',
        utils.Logger.errors.CALL_EXCEPTION,
      );
      // Non-empty revert data must NOT be recognized as a missing selector.
      expect(thrown).to.have.property('data', `0x${REVERT_DATA}`);
    });

    it('throws the decoded message on a pre-execution failure (no constant_result)', async () => {
      const provider = fallbackProvider();
      stubFullNode(provider, {
        result: {
          result: false,
          message: realTronWeb.fromUtf8('contract not found'),
        },
      });

      await expect(
        provider.call({ to: CONTRACT, data: SELECTOR }),
      ).to.be.rejectedWith('Tron constant call failed: contract not found');
    });

    it('throws on a malformed response (no constant_result, no result)', async () => {
      const provider = fallbackProvider();
      stubFullNode(provider, {});

      await expect(
        provider.call({ to: CONTRACT, data: SELECTOR }),
      ).to.be.rejectedWith('Tron constant call failed: unknown error');
    });
  });

  describe('caller (owner_address)', () => {
    function fallbackProvider(): TronJsonRpcProvider {
      const provider = makeProvider();
      stubSend(provider, throwingSend(TRANSPORT_ERROR));
      return provider;
    }

    it('uses the Tron zero address as caller when `from` is omitted', async () => {
      const provider = fallbackProvider();
      const captured: Captured = { calls: 0 };
      stubFullNode(
        provider,
        { result: { result: true }, constant_result: ['00'] },
        captured,
      );

      await provider.call({ to: CONTRACT, data: SELECTOR });

      expect(captured.value?.payload['owner_address']).to.equal(
        toTronHex(realTronWeb, TRON_EMPTY_ADDRESS),
      );
    });

    it('preserves an explicit `from` as the caller', async () => {
      const provider = fallbackProvider();
      const captured: Captured = { calls: 0 };
      stubFullNode(
        provider,
        { result: { result: true }, constant_result: ['00'] },
        captured,
      );
      const from = '0x496ba8ba0871a037ec1617f002f0a4afe5c2bae1';

      await provider.call({ to: CONTRACT, data: SELECTOR, from });

      expect(captured.value?.payload['owner_address']).to.equal(
        toTronHex(realTronWeb, from),
      );
    });
  });

  describe('isAccountActive', () => {
    it('posts the base58 address to the raw account endpoint', async () => {
      const provider = makeProvider();
      const captured: Captured = { calls: 0 };
      stubFullNode(provider, ACTIVE_EOA_ACCOUNT, captured);

      await provider.isAccountActive(EOA);

      expect(captured.value?.url).to.equal('wallet/getaccount');
      expect(captured.value?.method).to.equal('post');
      expect(captured.value?.payload['address']).to.equal(EOA_BASE58);
      expect(captured.value?.payload['visible']).to.equal(true);
    });

    it('returns true for an activated account', async () => {
      const provider = makeProvider();
      stubFullNode(provider, ACTIVE_EOA_ACCOUNT);

      expect(await provider.isAccountActive(EOA)).to.be.true;
    });

    it('returns true for a contract account, which carries no create_time', async () => {
      const provider = makeProvider();
      stubFullNode(provider, ACTIVE_CONTRACT_ACCOUNT);

      expect(await provider.isAccountActive(CONTRACT)).to.be.true;
    });

    it('returns false for an unactivated account (empty response)', async () => {
      const provider = makeProvider();
      stubFullNode(provider, {});

      expect(await provider.isAccountActive(EOA)).to.be.false;
    });

    it('throws on a missing response body', async () => {
      const provider = makeProvider();
      // The node answered with no JSON body at all, which must not read as a
      // missing account.
      stubFullNodeRequest(provider, async () => undefined);

      const thrown = await rejectionOf(provider.isAccountActive(EOA));

      expect(thrown).to.have.property(
        'message',
        `Tron account lookup returned no response body for ${EOA_BASE58}`,
      );
    });

    it('throws on a node-level error response', async () => {
      const provider = makeProvider();
      stubFullNode(provider, { Error: 'Invalid address' });

      const thrown = await rejectionOf(provider.isAccountActive(EOA));

      expect(thrown).to.have.property(
        'message',
        'Tron account lookup failed: Invalid address',
      );
    });

    it('rejects on a transport failure instead of reporting inactive', async () => {
      const provider = makeProvider();
      stubFullNodeRequest(provider, throwingRequest(TRANSPORT_ERROR));

      const thrown = await rejectionOf(provider.isAccountActive(EOA));

      expect(thrown).to.equal(TRANSPORT_ERROR);
    });

    it('retries a transient failure before resolving', async () => {
      const provider = makeProvider(2);
      let calls = 0;
      stubFullNodeRequest(provider, async () => {
        calls += 1;
        if (calls === 1) {
          throw TRANSPORT_ERROR;
        }
        return ACTIVE_EOA_ACCOUNT;
      });

      expect(await provider.isAccountActive(EOA)).to.be.true;
      expect(calls).to.equal(2);
    });
  });
});

describe('toTronHex', () => {
  it('resolves base58 addresses through TronWeb', () => {
    expect(
      toTronHex(realTronWeb, 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb'),
    ).to.equal('410000000000000000000000000000000000000000');
  });

  it('passes through already-41-prefixed hex', () => {
    expect(toTronHex(realTronWeb, CONTRACT_HEX)).to.equal(CONTRACT_HEX);
  });

  it('prefixes 0x hex with the Tron 41 byte', () => {
    expect(toTronHex(realTronWeb, CONTRACT)).to.equal(CONTRACT_HEX);
  });
});
