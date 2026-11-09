import { expect } from 'chai';
import { ethers } from 'ethers';
import { pino } from 'pino';
import { Registry } from 'prom-client';
import sinon from 'sinon';

import { WormholeVaaHookIsm__factory } from '@hyperlane-xyz/core';
import { ModuleType, MultiProvider, OnchainHookType } from '@hyperlane-xyz/sdk';
import { addressToBytes32, assert } from '@hyperlane-xyz/utils';

import { WormholeVaaFetcher } from '../../src/services/WormholeVaaFetcher.js';
import {
  WormholeVaaService,
  type WormholeVaaServiceConfig,
} from '../../src/services/WormholeVaaService.js';
import {
  PrometheusMetrics,
  UnhandledErrorReason,
  initializeMetrics,
} from '../../src/utils/prometheus.js';
import {
  LOG_MESSAGE_PUBLISHED_ABI,
  WORMHOLE_PAYLOAD_MAGIC,
  WORMHOLE_PAYLOAD_VERSION,
  type WormholePayload,
  encodeWormholePayload,
  parseVaa,
} from '../../src/services/wormholeVaaMatcher.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ORIGIN_DOMAIN = 31338;
const DESTINATION_DOMAIN = 31347;
const ORIGIN_CHAIN = 'anvil2';
const DESTINATION_CHAIN = 'anvil3';

const ORIGIN_CORE = '0x98f3c9e6E3fAce36bAAd05FE09d375Ef1464288B';
const DESTINATION_CORE = '0xbebdb6C8ddC678FfA9f8748f85C815C556Dd8ac6';
const ORIGIN_ROUTER = '0x1111111111111111111111111111111111111111';
const DESTINATION_ROUTER = '0x2222222222222222222222222222222222222222';

const WH_ORIGIN = 2;
const WH_DESTINATION = 30;

const NONCE = 3;
const SEQUENCE = '11';
const CONSISTENCY_LEVEL = 15;
const TX_HASH = `0x${'ab'.repeat(32)}`;
const VAA_URL = 'https://example.test';

const iface = new ethers.utils.Interface(LOG_MESSAGE_PUBLISHED_ABI);

const routerInterface = WormholeVaaHookIsm__factory.createInterface();

interface RouterState {
  localDomain: number;
  core: string;
  wormholeChainId: number;
  hookType: number;
  remoteDomain: number;
  remoteRouter: string;
  remoteWormholeChainId: number;
}

const ORIGIN_ROUTER_STATE: RouterState = {
  localDomain: ORIGIN_DOMAIN,
  core: ORIGIN_CORE,
  wormholeChainId: WH_ORIGIN,
  hookType: OnchainHookType.WORMHOLE,
  remoteDomain: DESTINATION_DOMAIN,
  remoteRouter: DESTINATION_ROUTER,
  remoteWormholeChainId: WH_DESTINATION,
};

const DESTINATION_ROUTER_STATE: RouterState = {
  localDomain: DESTINATION_DOMAIN,
  core: DESTINATION_CORE,
  wormholeChainId: WH_DESTINATION,
  hookType: OnchainHookType.WORMHOLE,
  remoteDomain: ORIGIN_DOMAIN,
  remoteRouter: ORIGIN_ROUTER,
  remoteWormholeChainId: WH_ORIGIN,
};

function routerStates(
  origin: RouterState = ORIGIN_ROUTER_STATE,
  destination: RouterState = DESTINATION_ROUTER_STATE,
): Record<string, RouterState> {
  return {
    [ORIGIN_ROUTER.toLowerCase()]: origin,
    [DESTINATION_ROUTER.toLowerCase()]: destination,
  };
}

function routerCall(router: RouterState, data: string): string {
  const call = routerInterface.parseTransaction({ data });
  const results: Record<string, Array<unknown>> = {
    wormholeCoreBridge: [router.core],
    localDomain: [router.localDomain],
    wormholeChainId: [router.wormholeChainId],
    hookType: [router.hookType],
    moduleType: [ModuleType.CCIP_READ],
    routers: [addressToBytes32(router.remoteRouter)],
    remoteRouterConfigs: [
      router.remoteWormholeChainId,
      {
        consistencyLevel: CONSISTENCY_LEVEL,
        customBaseConsistencyLevel: 0,
        additionalBlocks: 0,
      },
    ],
  };
  const result = results[call.name];
  assert(result, `Unexpected router call ${call.name}`);
  return routerInterface.encodeFunctionResult(call.functionFragment, result);
}

function buildMessage(): string {
  return ethers.utils.solidityPack(
    ['uint8', 'uint32', 'uint32', 'bytes32', 'uint32', 'bytes32', 'bytes'],
    [
      3,
      NONCE,
      ORIGIN_DOMAIN,
      addressToBytes32('0x3333333333333333333333333333333333333333'),
      DESTINATION_DOMAIN,
      addressToBytes32('0x4444444444444444444444444444444444444444'),
      ethers.utils.toUtf8Bytes('hello'),
    ],
  );
}

function buildPayload(
  messageId: string,
  overrides: Partial<WormholePayload> = {},
) {
  return encodeWormholePayload({
    magic: WORMHOLE_PAYLOAD_MAGIC,
    version: WORMHOLE_PAYLOAD_VERSION,
    destinationRouter: addressToBytes32(DESTINATION_ROUTER),
    messageId,
    customBaseConsistencyLevel: 0,
    additionalBlocks: 0,
    ...overrides,
  });
}

function publicationLog(
  payload: string,
  overrides: { address?: string; sender?: string; sequence?: string } = {},
) {
  const encoded = iface.encodeEventLog(iface.getEvent('LogMessagePublished'), [
    overrides.sender ?? ORIGIN_ROUTER,
    overrides.sequence ?? SEQUENCE,
    NONCE,
    payload,
    CONSISTENCY_LEVEL,
  ]);
  return {
    address: overrides.address ?? ORIGIN_CORE,
    topics: encoded.topics,
    data: encoded.data,
  };
}

function encodeVaa(
  payload: string,
  overrides: {
    emitterChainId?: number;
    emitterAddress?: string;
    sequence?: string;
    nonce?: number;
    consistencyLevel?: number;
  } = {},
): string {
  const signatureCount = 13;
  const signatures = ethers.utils.hexlify(
    new Uint8Array(signatureCount * 66).fill(0xcd),
  );
  const body = ethers.utils.solidityPack(
    ['uint32', 'uint32', 'uint16', 'bytes32', 'uint64', 'uint8', 'bytes'],
    [
      1_700_000_000,
      overrides.nonce ?? NONCE,
      overrides.emitterChainId ?? WH_ORIGIN,
      overrides.emitterAddress ?? addressToBytes32(ORIGIN_ROUTER),
      overrides.sequence ?? SEQUENCE,
      overrides.consistencyLevel ?? CONSISTENCY_LEVEL,
      payload,
    ],
  );
  return ethers.utils.hexConcat([
    ethers.utils.solidityPack(
      ['uint8', 'uint32', 'uint8'],
      [1, 4, signatureCount],
    ),
    signatures,
    body,
  ]);
}

/** A `Log` shaped exactly as ethers returns it from a receipt. */
function toLog(
  entry: { address: string; topics: Array<string>; data: string },
  logIndex: number,
): ethers.providers.Log {
  return {
    blockNumber: 1,
    blockHash: `0x${'11'.repeat(32)}`,
    transactionIndex: 0,
    removed: false,
    address: entry.address,
    data: entry.data,
    topics: entry.topics,
    transactionHash: TX_HASH,
    logIndex,
  };
}

function toReceipt(
  entries: Array<{ address: string; topics: Array<string>; data: string }>,
): ethers.providers.TransactionReceipt {
  return {
    to: ORIGIN_CORE,
    from: ORIGIN_ROUTER,
    contractAddress: '',
    transactionIndex: 0,
    gasUsed: ethers.BigNumber.from(21_000),
    logsBloom: `0x${'00'.repeat(256)}`,
    blockHash: `0x${'11'.repeat(32)}`,
    transactionHash: TX_HASH,
    logs: entries.map(toLog),
    blockNumber: 1,
    confirmations: 1,
    cumulativeGasUsed: ethers.BigNumber.from(21_000),
    effectiveGasPrice: ethers.BigNumber.from(1),
    byzantium: true,
    type: 2,
    status: 1,
  };
}

interface ServiceHarness {
  service: WormholeVaaService;
  getTransactionReceipt: sinon.SinonStub;
  explorerLookup: sinon.SinonStub;
}

interface Harness extends ServiceHarness {
  fetchVaa: sinon.SinonStub;
}

interface ServiceOptions {
  routers?: Record<string, RouterState>;
  vaaUrls?: Array<string>;
  maxAttempts?: number;
}

function buildService(
  entries: Array<{ address: string; topics: Array<string>; data: string }>,
  vaaFetcher: WormholeVaaServiceConfig['vaaFetcher'],
  {
    routers = routerStates(),
    vaaUrls = [VAA_URL],
    maxAttempts = 1,
  }: ServiceOptions = {},
): ServiceHarness {
  const provider = new ethers.providers.JsonRpcProvider('http://127.0.0.1:1');
  const getTransactionReceipt = sinon
    .stub(provider, 'getTransactionReceipt')
    .resolves(toReceipt(entries));
  sinon.stub(provider, 'call').callsFake(async (transaction) => {
    const { to, data } = await ethers.utils.resolveProperties(transaction);
    assert(
      typeof to === 'string' && typeof data === 'string',
      'Malformed eth_call',
    );
    const router = routers[to.toLowerCase()];
    assert(router, `Unexpected eth_call to ${to}`);
    return routerCall(router, data);
  });

  const multiProvider = sinon.createStubInstance(MultiProvider);
  multiProvider.getProvider.returns(provider);
  multiProvider.tryGetProvider.returns(provider);
  multiProvider.tryGetChainName.callsFake((domain) =>
    domain === ORIGIN_DOMAIN
      ? ORIGIN_CHAIN
      : domain === DESTINATION_DOMAIN
        ? DESTINATION_CHAIN
        : null,
  );

  const explorerLookup = sinon.stub().resolves(TX_HASH);

  const service = new WormholeVaaService({
    serviceName: 'wormhole',
    multiProvider,
    vaaUrls,
    maxAttempts,
    baseRetryDelayMs: 1,
    vaaFetcher,
    hyperlaneService: {
      getOriginTransactionHashByMessageId: explorerLookup,
    },
  });

  return { service, getTransactionReceipt, explorerLookup };
}

function harness(
  entries: Array<{ address: string; topics: Array<string>; data: string }>,
  vaa: string,
  options: ServiceOptions = {},
): Harness {
  const fetchVaa = sinon.stub();
  fetchVaa.resolves({ encodedVaa: vaa, vaa: parseVaa(vaa) });

  const { service, getTransactionReceipt, explorerLookup } = buildService(
    entries,
    { fetchVaa },
    options,
  );

  return { service, getTransactionReceipt, fetchVaa, explorerLookup };
}

function realFetcher(): WormholeVaaFetcher {
  return new WormholeVaaFetcher('wormhole', {
    timeoutMs: 1_000,
    maxResponseBytes: 65_536,
  });
}

function vaaUrlFor(baseUrl: string, sequence = SEQUENCE): string {
  return `${baseUrl}/api/v1/vaas/${WH_ORIGIN}/${'00'.repeat(12)}${'11'.repeat(20)}/${sequence}`;
}

function vaaResponse(encodedVaa: string): Response {
  return new Response(JSON.stringify({ data: { vaa: encodedVaa } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const logger = pino({ level: 'silent' });

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('WormholeVaaService', () => {
  before(() => initializeMetrics(new Registry()));
  afterEach(() => sinon.restore());

  it('returns the raw VAA bytes for a matching publication', async () => {
    const message = buildMessage();
    const messageId = ethers.utils.keccak256(message);
    const payload = buildPayload(messageId);
    const vaa = encodeVaa(payload);
    const { service } = harness([publicationLog(payload)], vaa);

    const result = await service.getWormholeVaa(
      message,
      DESTINATION_ROUTER,
      TX_HASH,
      logger,
    );

    expect(result).to.equal(vaa);
  });

  it('uses the relayer-provided origin transaction hash', async () => {
    const message = buildMessage();
    const payload = buildPayload(ethers.utils.keccak256(message));
    const { service, getTransactionReceipt, explorerLookup } = harness(
      [publicationLog(payload)],
      encodeVaa(payload),
    );

    await service.getWormholeVaa(message, DESTINATION_ROUTER, TX_HASH, logger);

    expect(getTransactionReceipt.calledOnceWith(TX_HASH)).to.be.true;
    expect(explorerLookup.called).to.be.false;
  });

  it('falls back to the Explorer when the relayer sends no tx hash', async () => {
    const message = buildMessage();
    const payload = buildPayload(ethers.utils.keccak256(message));
    const { service, explorerLookup, getTransactionReceipt } = harness(
      [publicationLog(payload)],
      encodeVaa(payload),
    );

    await service.getWormholeVaa(
      message,
      DESTINATION_ROUTER,
      undefined,
      logger,
    );

    expect(explorerLookup.calledOnce).to.be.true;
    expect(getTransactionReceipt.calledOnceWith(TX_HASH)).to.be.true;
  });

  it('looks up the VAA by the origin emitter and published sequence', async () => {
    const message = buildMessage();
    const payload = buildPayload(ethers.utils.keccak256(message));
    const { service, fetchVaa } = harness(
      [publicationLog(payload)],
      encodeVaa(payload),
    );

    await service.getWormholeVaa(message, DESTINATION_ROUTER, TX_HASH, logger);

    const [url, chainId, emitter, sequence] = fetchVaa.firstCall.args;
    expect(url).to.equal(VAA_URL);
    expect(chainId).to.equal(WH_ORIGIN);
    expect(emitter).to.equal(addressToBytes32(ORIGIN_ROUTER));
    expect(sequence).to.equal(SEQUENCE);
  });

  it('rejects a receipt with no Core publication', async () => {
    const message = buildMessage();
    const { service } = harness(
      [],
      encodeVaa(buildPayload(ethers.utils.keccak256(message))),
    );

    await expectRejection(
      service.getWormholeVaa(message, DESTINATION_ROUTER, TX_HASH, logger),
      'No Wormhole publication',
    );
  });

  it('ignores a lookalike publication from a non-Core address', async () => {
    const message = buildMessage();
    const payload = buildPayload(ethers.utils.keccak256(message));
    const { service } = harness(
      [publicationLog(payload, { address: DESTINATION_CORE })],
      encodeVaa(payload),
    );

    await expectRejection(
      service.getWormholeVaa(message, DESTINATION_ROUTER, TX_HASH, logger),
      'No Wormhole publication',
    );
  });

  it('ignores a Core publication from a non-enrolled emitter', async () => {
    const message = buildMessage();
    const payload = buildPayload(ethers.utils.keccak256(message));
    const { service } = harness(
      [publicationLog(payload, { sender: DESTINATION_ROUTER })],
      encodeVaa(payload),
    );

    await expectRejection(
      service.getWormholeVaa(message, DESTINATION_ROUTER, TX_HASH, logger),
      'No Wormhole publication',
    );
  });

  it('disambiguates when the receipt holds several publications', async () => {
    const message = buildMessage();
    const messageId = ethers.utils.keccak256(message);
    const payload = buildPayload(messageId);
    const other = buildPayload(ethers.utils.id('another message'));
    const vaa = encodeVaa(payload);
    const { service } = harness(
      [publicationLog(other, { sequence: '10' }), publicationLog(payload)],
      vaa,
    );

    const result = await service.getWormholeVaa(
      message,
      DESTINATION_ROUTER,
      TX_HASH,
      logger,
    );

    expect(result).to.equal(vaa);
  });

  it('rejects an ambiguous receipt with two publications for one message', async () => {
    const message = buildMessage();
    const payload = buildPayload(ethers.utils.keccak256(message));
    const { service } = harness(
      [publicationLog(payload), publicationLog(payload, { sequence: '12' })],
      encodeVaa(payload),
    );

    await expectRejection(
      service.getWormholeVaa(message, DESTINATION_ROUTER, TX_HASH, logger),
      'Ambiguous receipt',
    );
  });

  it('rejects an upstream VAA whose payload differs from the publication', async () => {
    const message = buildMessage();
    const payload = buildPayload(ethers.utils.keccak256(message));
    const tampered = buildPayload(ethers.utils.id('tampered'));
    const { service } = harness([publicationLog(payload)], encodeVaa(tampered));

    await expectRejection(
      service.getWormholeVaa(message, DESTINATION_ROUTER, TX_HASH, logger),
      'VAA payload does not match',
    );
  });

  it('queries the endpoint again after rejecting a mismatched VAA', async () => {
    const message = buildMessage();
    const payload = buildPayload(ethers.utils.keccak256(message));
    const vaa = encodeVaa(payload);
    const tampered = encodeVaa(buildPayload(ethers.utils.id('tampered')));
    const fetchStub = sinon.stub(globalThis, 'fetch');
    fetchStub.onCall(0).resolves(vaaResponse(tampered));
    fetchStub.onCall(1).resolves(vaaResponse(vaa));
    const { service } = buildService([publicationLog(payload)], realFetcher());
    const vaaUrl = vaaUrlFor(VAA_URL);

    await expectRejection(
      service.getWormholeVaa(message, DESTINATION_ROUTER, TX_HASH, logger),
      'VAA payload does not match',
    );
    const result = await service.getWormholeVaa(
      message,
      DESTINATION_ROUTER,
      TX_HASH,
      logger,
    );

    expect(result).to.equal(vaa);
    expect(fetchStub.callCount).to.equal(2);
    expect(fetchStub.firstCall.args[0]).to.equal(vaaUrl);
    expect(fetchStub.secondCall.args[0]).to.equal(vaaUrl);
  });

  it('rejects an upstream VAA from another emitter chain', async () => {
    const message = buildMessage();
    const payload = buildPayload(ethers.utils.keccak256(message));
    const { service } = harness(
      [publicationLog(payload)],
      encodeVaa(payload, { emitterChainId: WH_DESTINATION }),
    );

    await expectRejection(
      service.getWormholeVaa(message, DESTINATION_ROUTER, TX_HASH, logger),
      `Endpoint served VAA ${WH_DESTINATION}/`,
    );
  });

  it('rejects a message whose origin chain has no configured route', async () => {
    const message = ethers.utils.solidityPack(
      ['uint8', 'uint32', 'uint32', 'bytes32', 'uint32', 'bytes32', 'bytes'],
      [
        3,
        NONCE,
        999_999,
        addressToBytes32(ORIGIN_ROUTER),
        DESTINATION_DOMAIN,
        addressToBytes32(DESTINATION_ROUTER),
        '0x',
      ],
    );
    const { service, getTransactionReceipt } = harness(
      [],
      encodeVaa(buildPayload(ethers.utils.id('x'))),
    );

    await expectRejection(
      service.getWormholeVaa(message, DESTINATION_ROUTER, TX_HASH, logger),
      'Unknown Hyperlane origin domain 999999',
    );
    expect(getTransactionReceipt.called).to.be.false;
  });

  it('rejects a request without a CCIP sender', async () => {
    const message = buildMessage();
    const payload = buildPayload(ethers.utils.keccak256(message));
    const { service, getTransactionReceipt } = harness(
      [publicationLog(payload)],
      encodeVaa(payload),
    );

    await expectRejection(
      service.getWormholeVaa(message, undefined, TX_HASH, logger),
      'Invalid Wormhole CCIP sender',
    );
    expect(getTransactionReceipt.called).to.be.false;
  });

  it('rejects a CCIP sender that is not the destination router', async () => {
    const message = buildMessage();
    const payload = buildPayload(ethers.utils.keccak256(message));
    const { service, getTransactionReceipt } = harness(
      [publicationLog(payload)],
      encodeVaa(payload),
    );

    await expectRejection(
      service.getWormholeVaa(message, ORIGIN_ROUTER, TX_HASH, logger),
      `Wormhole router ${ORIGIN_ROUTER} reports Hyperlane domain ${ORIGIN_DOMAIN}; expected ${DESTINATION_DOMAIN}`,
    );
    expect(getTransactionReceipt.called).to.be.false;
  });

  it('rejects a CCIP sender that is not a Wormhole hook', async () => {
    const message = buildMessage();
    const payload = buildPayload(ethers.utils.keccak256(message));
    const { service, getTransactionReceipt } = harness(
      [publicationLog(payload)],
      encodeVaa(payload),
      {
        routers: routerStates(ORIGIN_ROUTER_STATE, {
          localDomain: DESTINATION_DOMAIN,
          core: DESTINATION_CORE,
          wormholeChainId: WH_DESTINATION,
          hookType: OnchainHookType.ROUTING,
          remoteDomain: ORIGIN_DOMAIN,
          remoteRouter: ORIGIN_ROUTER,
          remoteWormholeChainId: WH_ORIGIN,
        }),
      },
    );

    await expectRejection(
      service.getWormholeVaa(message, DESTINATION_ROUTER, TX_HASH, logger),
      `Contract ${DESTINATION_ROUTER} on domain ${DESTINATION_DOMAIN} is not a Wormhole hook`,
    );
    expect(getTransactionReceipt.called).to.be.false;
  });

  it('rejects an origin router that enrolls a different destination', async () => {
    const message = buildMessage();
    const payload = buildPayload(ethers.utils.keccak256(message));
    const { service, getTransactionReceipt } = harness(
      [publicationLog(payload)],
      encodeVaa(payload),
      {
        routers: routerStates({
          localDomain: ORIGIN_DOMAIN,
          core: ORIGIN_CORE,
          wormholeChainId: WH_ORIGIN,
          hookType: OnchainHookType.WORMHOLE,
          remoteDomain: DESTINATION_DOMAIN,
          remoteRouter: '0x5555555555555555555555555555555555555555',
          remoteWormholeChainId: WH_DESTINATION,
        }),
      },
    );

    await expectRejection(
      service.getWormholeVaa(message, DESTINATION_ROUTER, TX_HASH, logger),
      `Wormhole routers are not reciprocally enrolled for ${ORIGIN_DOMAIN} -> ${DESTINATION_DOMAIN}`,
    );
    expect(getTransactionReceipt.called).to.be.false;
  });

  it('rejects routers whose Wormhole chain IDs disagree', async () => {
    const message = buildMessage();
    const payload = buildPayload(ethers.utils.keccak256(message));
    const { service, getTransactionReceipt } = harness(
      [publicationLog(payload)],
      encodeVaa(payload),
      {
        routers: routerStates(ORIGIN_ROUTER_STATE, {
          localDomain: DESTINATION_DOMAIN,
          core: DESTINATION_CORE,
          wormholeChainId: WH_DESTINATION,
          hookType: OnchainHookType.WORMHOLE,
          remoteDomain: ORIGIN_DOMAIN,
          remoteRouter: ORIGIN_ROUTER,
          remoteWormholeChainId: 7,
        }),
      },
    );

    await expectRejection(
      service.getWormholeVaa(message, DESTINATION_ROUTER, TX_HASH, logger),
      `Wormhole chain IDs are inconsistent for ${ORIGIN_DOMAIN} -> ${DESTINATION_DOMAIN}`,
    );
    expect(getTransactionReceipt.called).to.be.false;
  });

  describe('with redundant VAA endpoints', () => {
    const FIRST_URL = 'https://a.example.test';
    const SECOND_URL = 'https://b.example.test';
    const CREDENTIALED_SECOND_URL = 'https://user:secret@b.example.test';

    /** Serves each endpoint by base URL, so parallel requests can race. */
    function stubEndpoints(
      endpoints: Record<string, () => Promise<Response>>,
    ): sinon.SinonStub {
      return sinon.stub(globalThis, 'fetch').callsFake(async (input) => {
        assert(typeof input === 'string', 'Expected a string request URL');
        const endpoint = Object.entries(endpoints).find(([baseUrl]) =>
          input.startsWith(`${baseUrl}/`),
        );
        assert(endpoint, `Unexpected request to ${input}`);
        const [, respond] = endpoint;
        return respond();
      });
    }

    const notFound = async () => new Response('{}', { status: 404 });
    const unavailable = async () =>
      new Response('unavailable', { status: 503 });

    function lookup(vaaUrls: Array<string>, maxAttempts = 1) {
      const message = buildMessage();
      const payload = buildPayload(ethers.utils.keccak256(message));
      const { service } = buildService(
        [publicationLog(payload)],
        realFetcher(),
        { vaaUrls, maxAttempts },
      );
      return {
        payload,
        run: () =>
          service.getWormholeVaa(message, DESTINATION_ROUTER, TX_HASH, logger),
      };
    }

    it('returns a matching VAA while another endpoint hangs', async () => {
      const { payload, run } = lookup([FIRST_URL, SECOND_URL]);
      const vaa = encodeVaa(payload);
      const fetchStub = stubEndpoints({
        [FIRST_URL]: () => new Promise<Response>(() => {}),
        [SECOND_URL]: async () => vaaResponse(vaa),
      });

      const result = await run();

      expect(result).to.equal(vaa);
      expect(fetchStub.args.map(([url]) => url)).to.have.members([
        vaaUrlFor(FIRST_URL),
        vaaUrlFor(SECOND_URL),
      ]);
    });

    it('skips an endpoint whose VAA locator does not match the request', async () => {
      const { payload, run } = lookup([FIRST_URL, SECOND_URL]);
      const vaa = encodeVaa(payload);
      stubEndpoints({
        [FIRST_URL]: async () =>
          vaaResponse(encodeVaa(payload, { sequence: '12' })),
        [SECOND_URL]: async () => vaaResponse(vaa),
      });

      expect(await run()).to.equal(vaa);
    });

    it('moves on when an endpoint serves the right locator with a mismatched body', async () => {
      const { payload, run } = lookup([FIRST_URL, SECOND_URL]);
      const vaa = encodeVaa(payload);
      const tampered = encodeVaa(buildPayload(ethers.utils.id('tampered')));
      stubEndpoints({
        [FIRST_URL]: async () => vaaResponse(tampered),
        [SECOND_URL]: async () => vaaResponse(vaa),
      });
      const logUnhandledError = sinon.spy(
        PrometheusMetrics,
        'logUnhandledError',
      );

      const result = await run();

      expect(result).to.equal(vaa);
      expect(logUnhandledError.called).to.be.false;
    });

    it('names every endpoint when all of them serve a mismatched VAA', async () => {
      const { run } = lookup([FIRST_URL, CREDENTIALED_SECOND_URL]);
      const tampered = encodeVaa(buildPayload(ethers.utils.id('tampered')));
      stubEndpoints({
        [FIRST_URL]: async () => vaaResponse(tampered),
        [CREDENTIALED_SECOND_URL]: async () => vaaResponse(tampered),
      });
      const logUnhandledError = sinon.spy(
        PrometheusMetrics,
        'logUnhandledError',
      );

      const error = await rejectionOf(run());

      expect(error).to.include(
        `${FIRST_URL}: VAA payload does not match the published payload`,
      );
      expect(error).to.include(
        `${SECOND_URL}: VAA payload does not match the published payload`,
      );
      expect(error).not.to.include('secret');
      expect(logUnhandledError.args).to.deep.equal([
        ['wormhole', UnhandledErrorReason.WORMHOLE_VAA_MISMATCH],
      ]);
    });

    it('reports an unavailable VAA when only some endpoints serve a mismatched VAA', async () => {
      const { run } = lookup([FIRST_URL, SECOND_URL]);
      const tampered = encodeVaa(buildPayload(ethers.utils.id('tampered')));
      stubEndpoints({
        [FIRST_URL]: async () => vaaResponse(tampered),
        [SECOND_URL]: unavailable,
      });
      const logUnhandledError = sinon.spy(
        PrometheusMetrics,
        'logUnhandledError',
      );

      const error = await rejectionOf(run());

      expect(error).to.include(
        `${FIRST_URL}: VAA payload does not match the published payload`,
      );
      expect(error).to.include(`${SECOND_URL}: VAA endpoint returned 503`);
      expect(logUnhandledError.args).to.deep.equal([
        ['wormhole', UnhandledErrorReason.WORMHOLE_VAA_UNAVAILABLE],
      ]);
    });

    it('reports a pending VAA when one endpoint has none yet and another fails', async () => {
      const { run } = lookup([FIRST_URL, SECOND_URL]);
      const fetchStub = stubEndpoints({
        [FIRST_URL]: notFound,
        [SECOND_URL]: unavailable,
      });

      await expectRejection(run(), 'is pending Guardian signatures');
      expect(fetchStub.callCount).to.equal(2);
    });

    it('retries every endpoint while the VAA stays pending', async () => {
      const { run } = lookup([FIRST_URL, SECOND_URL], 3);
      const fetchStub = stubEndpoints({
        [FIRST_URL]: notFound,
        [SECOND_URL]: notFound,
      });

      await expectRejection(run(), 'is pending Guardian signatures');
      expect(fetchStub.callCount).to.equal(6);
    });

    it('returns the VAA once a pending endpoint serves it', async () => {
      const { payload, run } = lookup([FIRST_URL], 3);
      const vaa = encodeVaa(payload);
      const fetchStub = sinon.stub(globalThis, 'fetch');
      fetchStub.onCall(0).callsFake(notFound);
      fetchStub.onCall(1).resolves(vaaResponse(vaa));

      expect(await run()).to.equal(vaa);
      expect(fetchStub.callCount).to.equal(2);
    });

    it('does not retry when no endpoint reports the VAA as pending', async () => {
      const { run } = lookup([FIRST_URL, SECOND_URL], 3);
      const fetchStub = stubEndpoints({
        [FIRST_URL]: unavailable,
        [SECOND_URL]: unavailable,
      });

      await expectRejection(run(), `${FIRST_URL}: VAA endpoint returned 503`);
      expect(fetchStub.callCount).to.equal(2);
    });
  });
});

async function rejectionOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  expect.fail('Expected the lookup to reject');
}

async function expectRejection(
  promise: Promise<unknown>,
  expectedMessage: string,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error instanceof Error ? error.message : String(error)).to.include(
      expectedMessage,
    );
    return;
  }
  expect.fail(`Expected rejection containing "${expectedMessage}"`);
}
