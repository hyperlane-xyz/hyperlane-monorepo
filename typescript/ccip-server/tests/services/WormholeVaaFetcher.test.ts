import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { ethers } from 'ethers';
import { pino } from 'pino';
import { Registry } from 'prom-client';
import sinon from 'sinon';

import {
  WormholeVaaFetcher,
  type WormholeVaaFetcherConfig,
} from '../../src/services/WormholeVaaFetcher.js';
import { initializeMetrics } from '../../src/utils/prometheus.js';

const logger = pino({ enabled: false });
const emitterAddress = `0x${'11'.repeat(32)}`;

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
    urls: ['https://example.test'],
    timeoutMs: 1_000,
    maxResponseBytes: 65_536,
    maxAttempts: 1,
    baseRetryDelayMs: 1,
    ...overrides,
  };
}

describe('WormholeVaaFetcher', () => {
  before(() => initializeMetrics(new Registry()));

  afterEach(() => sinon.restore());

  it('skips an endpoint whose VAA locator does not match the request', async () => {
    const fetchStub = sinon.stub(globalThis, 'fetch');
    fetchStub.onCall(0).resolves(responseFor(2));
    fetchStub.onCall(1).resolves(responseFor(1));
    const fetcher = new WormholeVaaFetcher(
      'wormhole-test',
      config({ urls: ['https://a.example.test', 'https://b.example.test'] }),
    );

    const result = await fetcher.fetchVaa(3, emitterAddress, '1', logger);

    expect(result.encodedVaa).to.equal(encodeVaa(1));
    expect(result.vaa.sequence).to.equal('1');
    expect(fetchStub.callCount).to.equal(2);
    expect(fetchStub.firstCall.args[0]).to.equal(
      `https://a.example.test/api/v1/vaas/3/${'11'.repeat(32)}/1`,
    );
    expect(fetchStub.secondCall.args[0]).to.equal(
      `https://b.example.test/api/v1/vaas/3/${'11'.repeat(32)}/1`,
    );
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
      fetcher.fetchVaa(3, emitterAddress, '1', logger),
    ).to.be.rejectedWith('Unable to fetch VAA');
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
      fetcher.fetchVaa(3, emitterAddress, '1', logger),
    ).to.be.rejectedWith('Unable to fetch VAA');
  });
});
