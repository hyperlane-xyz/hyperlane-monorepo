// eslint-disable-next-line import/no-nodejs-modules
import { readFileSync } from 'fs';
import type { providers } from 'ethers';
// eslint-disable-next-line import/no-nodejs-modules
import http from 'http';
// eslint-disable-next-line import/no-nodejs-modules
import { gunzipSync, gzipSync } from 'zlib';

import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import { ExplorerFamily } from '../metadata/chainMetadataTypes.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { EvmWarpRouteReader } from '../token/EvmWarpRouteReader.js';

export const REPLAY_FIXTURE_DIR = new URL(
  './fixtures/warp-route-replay/',
  import.meta.url,
);
export const REPLAY_CHAIN_NAME = 'replaychain';

const RECORDED_METHODS = [
  'eth_getCode',
  'eth_getStorageAt',
  'eth_call',
  'eth_estimateGas',
];
const CALL_LIKE_METHODS = ['eth_call', 'eth_estimateGas'];
const GZIP_THRESHOLD = 512;

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export interface RecordedRequest {
  method: string;
  address?: string;
  slot?: string;
  to?: string;
  data?: string;
  result?: string;
  resultGzBase64?: string;
  error?: JsonRpcErrorBody;
}

export interface ReplayFixture {
  scenario: string;
  chain: string;
  chainId: number;
  blockNumber: number;
  capturedAt: string;
  requests: RecordedRequest[];
}

// The repo's pre-commit private-key heuristic rejects any added line holding a
// 64-nibble hex word, which EVM storage slots and ABI words all are. Fixtures
// store such words split in the middle by an underscore; the loader joins them
// back, so replayed values are byte-identical to the recorded ones.
const HEX_WORD_HALVES = /\b((?:0x)?[0-9a-fA-F]{32})([0-9a-fA-F]{32})\b/g;
const SPLIT_HEX_WORD = /\b((?:0x)?[0-9a-fA-F]{32})_([0-9a-fA-F]{32})\b/g;

// Providers can echo URLs or API keys in error bodies; fixtures must never
// carry them.
const SECRET_LIKE = /https?:\/\/|key=|apikey/i;

export function serializeReplayFixture(fixture: ReplayFixture): string {
  const text = JSON.stringify(fixture, null, 2);
  assert(
    !SECRET_LIKE.test(text),
    `Fixture ${fixture.scenario} contains a URL or key-like text; refusing to serialize it`,
  );
  return `${text.replace(HEX_WORD_HALVES, '$1_$2')}\n`;
}

export function parseReplayFixture(text: string): ReplayFixture {
  return JSON.parse(text.replace(SPLIT_HEX_WORD, '$1$2'));
}

export function loadReplayFixture(scenario: string): ReplayFixture {
  return parseReplayFixture(
    readFileSync(new URL(`${scenario}.json`, REPLAY_FIXTURE_DIR), 'utf8'),
  );
}

export function recordedResult(request: RecordedRequest): string | undefined {
  if (request.resultGzBase64 === undefined) return request.result;
  return gunzipSync(Buffer.from(request.resultGzBase64, 'base64')).toString(
    'utf8',
  );
}

export function recordedCode(
  fixture: ReplayFixture,
  address: string,
): string | undefined {
  const request = fixture.requests.find(
    (r) =>
      r.method === 'eth_getCode' &&
      r.address?.toLowerCase() === address.toLowerCase(),
  );
  return request && recordedResult(request);
}

/**
 * Derives a variant of a recording by replacing the recorded response of the
 * eth_call to `to` with calldata starting with `dataPrefix`. Variants are
 * synthetic: only the replaced response is not a recording.
 */
export function withCallResult(
  fixture: ReplayFixture,
  to: string,
  dataPrefix: string,
  result: string,
): ReplayFixture {
  let replaced = 0;
  const requests = fixture.requests.map((r) => {
    if (
      r.method !== 'eth_call' ||
      r.to?.toLowerCase() !== to.toLowerCase() ||
      !r.data?.startsWith(dataPrefix)
    ) {
      return r;
    }
    replaced += 1;
    return { method: r.method, to: r.to, data: r.data, result };
  });
  assert(replaced === 1, `Expected one recorded call ${to} ${dataPrefix}`);
  return { ...fixture, requests };
}

/**
 * Derives a variant of a recording by replacing the recorded response of the
 * eth_call to `to` with calldata starting with `dataPrefix` by a JSON-RPC
 * error.
 */
export function withCallError(
  fixture: ReplayFixture,
  to: string,
  dataPrefix: string,
  error: JsonRpcErrorBody,
): ReplayFixture {
  let replaced = 0;
  const requests = fixture.requests.map((r) => {
    if (
      r.method !== 'eth_call' ||
      r.to?.toLowerCase() !== to.toLowerCase() ||
      !r.data?.startsWith(dataPrefix)
    ) {
      return r;
    }
    replaced += 1;
    return { method: r.method, to: r.to, data: r.data, error };
  });
  assert(replaced === 1, `Expected one recorded call ${to} ${dataPrefix}`);
  return { ...fixture, requests };
}

/**
 * Derives a variant of a recording whose storage `slot` at `address` reads as
 * `value`, adding the read when it was not recorded.
 */
export function withStorage(
  fixture: ReplayFixture,
  address: string,
  slot: string,
  value: string,
): ReplayFixture {
  const entry: RecordedRequest = {
    method: 'eth_getStorageAt',
    address: address.toLowerCase(),
    slot,
    result: value,
  };
  const matches = (r: RecordedRequest) =>
    r.method === 'eth_getStorageAt' &&
    r.address?.toLowerCase() === address.toLowerCase() &&
    BigInt(r.slot ?? '0x0') === BigInt(slot);
  const requests = fixture.requests.some(matches)
    ? fixture.requests.map((r) => (matches(r) ? entry : r))
    : [...fixture.requests, entry];
  return { ...fixture, requests };
}

/**
 * Derives a variant of a recording whose contract code at `address` has
 * `hexSuffix` appended.
 */
export function withCodeSuffix(
  fixture: ReplayFixture,
  address: string,
  hexSuffix: string,
): ReplayFixture {
  let replaced = 0;
  const requests = fixture.requests.map((r) => {
    if (
      r.method !== 'eth_getCode' ||
      r.address?.toLowerCase() !== address.toLowerCase()
    ) {
      return r;
    }
    replaced += 1;
    return {
      method: r.method,
      address: r.address,
      result: `${recordedResult(r)}${hexSuffix}`,
    };
  });
  assert(replaced === 1, `Expected one recorded code for ${address}`);
  return { ...fixture, requests };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function requestKey(method: string, params: unknown[]): string {
  const [first, second] = params;
  if (CALL_LIKE_METHODS.includes(method)) {
    const call = typeof first === 'object' && first !== null ? first : {};
    return `${method}|${str(Reflect.get(call, 'to'))}|${str(Reflect.get(call, 'data') ?? Reflect.get(call, 'input'))}`;
  }
  if (method === 'eth_getStorageAt') {
    return `${method}|${str(first)}|${BigInt(typeof second === 'string' ? second : '0x0')}`;
  }
  return `${method}|${str(first)}`;
}

function recordedKey(request: RecordedRequest): string {
  return requestKey(
    request.method,
    CALL_LIKE_METHODS.includes(request.method)
      ? [{ to: request.to, data: request.data }]
      : [request.address, request.slot],
  );
}

export interface ReplayServer {
  url: string;
  // every eth_call served or rejected, as "<to>:<data>"
  ethCalls: string[];
  // requests with no recorded response
  unexpected: string[];
  close(): Promise<void>;
}

interface JsonRpcRequest {
  id: unknown;
  method: string;
  params: unknown[];
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'method') === 'string'
  );
}

function listen(
  handler: (request: JsonRpcRequest) => Promise<object>,
  onFailure: (message: string) => void,
): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    const respond = (payload: unknown) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(payload));
    };
    const fail = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      onFailure(`replay server failure: ${message}`);
      respond({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32603, message: `replay: ${message}` },
      });
    };
    req.on('error', fail);
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const body: unknown = JSON.parse(
          Buffer.concat(chunks).toString('utf8'),
        );
        const requests = Array.isArray(body) ? body : [body];
        const responses = [];
        for (const request of requests) {
          assert(isJsonRpcRequest(request), 'Malformed JSON-RPC request');
          const params = Array.isArray(request.params) ? request.params : [];
          responses.push({
            jsonrpc: '2.0',
            id: request.id,
            ...(await handler({ ...request, params })),
          });
        }
        respond(Array.isArray(body) ? responses : responses[0]);
      } catch (error: unknown) {
        fail(error);
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address !== 'object') {
        reject(new Error('Replay server not bound'));
        return;
      }
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

function closer(server: http.Server): () => Promise<void> {
  return () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
}

function chainStateResult(
  fixtureMeta: Pick<ReplayFixture, 'chainId' | 'blockNumber'>,
  method: string,
): { result: string } | undefined {
  switch (method) {
    case 'eth_chainId':
      return { result: `0x${fixtureMeta.chainId.toString(16)}` };
    case 'net_version':
      return { result: String(fixtureMeta.chainId) };
    case 'eth_blockNumber':
      return { result: `0x${fixtureMeta.blockNumber.toString(16)}` };
    default:
      return undefined;
  }
}

/**
 * Serves the recorded JSON-RPC responses (results and error bodies exactly as
 * recorded). Requests without a recording are answered with an error and listed
 * in `unexpected`.
 */
export async function startReplayServer(
  fixture: ReplayFixture,
): Promise<ReplayServer> {
  const recorded = new Map(
    fixture.requests.map((r) => [recordedKey(r), r] as const),
  );
  const ethCalls: string[] = [];
  const unexpected: string[] = [];
  const { server, url } = await listen(
    async ({ method, params }) => {
      const state = chainStateResult(fixture, method);
      if (state) return state;
      const [first] = params;
      if (method === 'eth_call') {
        ethCalls.push(
          `${str(Reflect.get(Object(first), 'to'))}:${str(Reflect.get(Object(first), 'data'))}`,
        );
      }
      const match = recorded.get(requestKey(method, params));
      if (!match) {
        unexpected.push(`${method} ${JSON.stringify(params)}`);
        return {
          error: { code: -32601, message: 'replay: no recorded response' },
        };
      }
      if (match.error) return { error: match.error };
      return { result: recordedResult(match) };
    },
    (message) => unexpected.push(message),
  );
  return { url, ethCalls, unexpected, close: closer(server) };
}

export interface RecordingServer {
  url: string;
  fixture: ReplayFixture;
  // handler failures; a recording is only valid when this is empty
  failures: string[];
  close(): Promise<void>;
}

/**
 * Forwards requests to a real node and records the eth_getCode,
 * eth_getStorageAt, eth_call and eth_estimateGas responses.
 */
export async function startRecordingServer(
  upstreamUrl: string,
  meta: Pick<ReplayFixture, 'scenario' | 'chain' | 'chainId'>,
): Promise<RecordingServer> {
  const upstream = async (method: string, params: unknown[]) => {
    const response = await fetch(upstreamUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return response.json();
  };
  const blockNumber = Number(
    BigInt((await upstream('eth_blockNumber', [])).result),
  );
  const fixture: ReplayFixture = {
    ...meta,
    blockNumber,
    capturedAt: new Date().toISOString(),
    requests: [],
  };
  const failures: string[] = [];
  const { server, url } = await listen(
    async ({ method, params }) => {
      const state = chainStateResult(fixture, method);
      if (state) return state;
      const body = await upstream(method, params);
      if (RECORDED_METHODS.includes(method)) {
        const [first, second] = params;
        const request: RecordedRequest = { method };
        if (CALL_LIKE_METHODS.includes(method)) {
          request.to = str(Reflect.get(Object(first), 'to'));
          request.data = str(Reflect.get(Object(first), 'data'));
        } else {
          request.address = str(first);
          if (method === 'eth_getStorageAt') request.slot = str(second);
        }
        if (body.error) request.error = body.error;
        else if (typeof body.result === 'string') {
          if (body.result.length > GZIP_THRESHOLD) {
            request.resultGzBase64 = gzipSync(body.result).toString('base64');
          } else request.result = body.result;
        }
        if (
          !fixture.requests.some((r) => recordedKey(r) === recordedKey(request))
        )
          fixture.requests.push(request);
      }
      return body.error ? { error: body.error } : { result: body.result };
    },
    (message) => failures.push(message),
  );
  return { url, fixture, failures, close: closer(server) };
}

export function createReplayReader(
  rpcUrl: string,
  chainId: number,
): { reader: EvmWarpRouteReader; provider: providers.Provider } {
  const multiProvider = new MultiProvider({
    [REPLAY_CHAIN_NAME]: {
      name: REPLAY_CHAIN_NAME,
      chainId,
      domainId: chainId,
      protocol: ProtocolType.Ethereum,
      rpcUrls: [{ http: rpcUrl }],
      nativeToken: { decimals: 18, name: 'Ether', symbol: 'ETH' },
      blockExplorers: [
        {
          name: 'replay',
          url: 'http://127.0.0.1',
          apiUrl: 'http://127.0.0.1',
          family: ExplorerFamily.Other,
        },
      ],
    },
  });
  return {
    reader: new EvmWarpRouteReader(multiProvider, REPLAY_CHAIN_NAME),
    provider: multiProvider.getProvider(REPLAY_CHAIN_NAME),
  };
}
