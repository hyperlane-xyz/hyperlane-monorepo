import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { ethers } from 'ethers';
import { pino } from 'pino';
import { Registry } from 'prom-client';
import sinon from 'sinon';

import {
  VaaPendingError,
  WormholeVaaFetcher,
  type WormholeVaaFetcherConfig,
} from '../../src/services/WormholeVaaFetcher.js';
import { initializeMetrics } from '../../src/utils/prometheus.js';

const logger = pino({ enabled: false });
const emitterAddress = `0x${'11'.repeat(32)}`;
const BASE_URL = 'https://example.test';
const VAA_URL = `${BASE_URL}/api/v1/vaas/3/${'11'.repeat(32)}/1`;

chai.use(chaiAsPromised);

function encodeVaa(sequence: number): string {
  const body = ethers.utils.solidityPack(
    ['uint32', 'uint32', 'uint16', 'bytes32', 'uint64', 'uint8', 'bytes'],
    [1, 2, 3, emitterAddress, sequence, 15, '0x1234'],
  );
  return ethers.utils.hexConcat([
    ethers.utils.solidityPack(['uint8', 'uint32', 'uint8'], [1, 4, 0]),
    body,
  ]);
}

function responseFor(sequence: number): Response {
  return new Response(JSON.stringify({ data: { vaa: encodeVaa(sequence) } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function config(
  overrides: Partial<WormholeVaaFetcherConfig> = {},
): WormholeVaaFetcherConfig {
  return {
    timeoutMs: 1_000,
    maxResponseBytes: 65_536,
    ...overrides,
  };
}

describe('WormholeVaaFetcher', () => {
  before(() => initializeMetrics(new Registry()));

  afterEach(() => sinon.restore());

  it('fetches the VAA from the endpoint in one request', async () => {
    const fetchStub = sinon.stub(globalThis, 'fetch').resolves(responseFor(1));
    const fetcher = new WormholeVaaFetcher('wormhole-test', config());

    const result = await fetcher.fetchVaa(
      BASE_URL,
      3,
      emitterAddress,
      '1',
      logger,
    );

    expect(result.encodedVaa).to.equal(encodeVaa(1));
    expect(result.vaa.sequence).to.equal('1');
    expect(fetchStub.callCount).to.equal(1);
    expect(fetchStub.firstCall.args[0]).to.equal(VAA_URL);
  });

  it('reports a pending VAA when the endpoint has none yet', async () => {
    const fetchStub = sinon
      .stub(globalThis, 'fetch')
      .resolves(new Response('{}', { status: 404 }));
    const fetcher = new WormholeVaaFetcher('wormhole-test', config());

    await expect(
      fetcher.fetchVaa(BASE_URL, 3, emitterAddress, '1', logger),
    ).to.be.rejectedWith(VaaPendingError);
    expect(fetchStub.callCount).to.equal(1);
  });

  it('does not retry a failing endpoint', async () => {
    const fetchStub = sinon
      .stub(globalThis, 'fetch')
      .resolves(new Response('unavailable', { status: 503 }));
    const fetcher = new WormholeVaaFetcher('wormhole-test', config());

    await expect(
      fetcher.fetchVaa(BASE_URL, 3, emitterAddress, '1', logger),
    ).to.be.rejectedWith(
      `VAA endpoint returned 503 for 3/${'11'.repeat(32)}/1`,
    );
    expect(fetchStub.callCount).to.equal(1);
  });

  it('rejects a chunked response as soon as it exceeds the byte limit', async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(9));
        controller.enqueue(new Uint8Array(8));
      },
      cancel() {
        canceled = true;
      },
    });
    sinon.stub(globalThis, 'fetch').resolves(new Response(body));

    const fetcher = new WormholeVaaFetcher(
      'wormhole-test',
      config({ maxResponseBytes: 16 }),
    );
    await expect(
      fetcher.fetchVaa(BASE_URL, 3, emitterAddress, '1', logger),
    ).to.be.rejectedWith(
      `VAA response for 3/${'11'.repeat(32)}/1 exceeds 16 bytes`,
    );
    expect(canceled).to.equal(true);
  });

  it('rejects an oversized declared content length without reading the body', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull() {},
    });
    sinon.stub(globalThis, 'fetch').resolves(
      new Response(body, {
        headers: { 'content-length': '17' },
      }),
    );

    const fetcher = new WormholeVaaFetcher(
      'wormhole-test',
      config({ maxResponseBytes: 16 }),
    );
    await expect(
      fetcher.fetchVaa(BASE_URL, 3, emitterAddress, '1', logger),
    ).to.be.rejectedWith(
      `VAA response for 3/${'11'.repeat(32)}/1 exceeds 16 bytes`,
    );
  });
});
