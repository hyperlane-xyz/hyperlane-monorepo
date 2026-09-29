import { expect } from 'chai';
import { ethers } from 'ethers';
import { pino } from 'pino';
import { Registry } from 'prom-client';
import sinon from 'sinon';

import { MultiProvider } from '@hyperlane-xyz/sdk';
import { addressToBytes32 } from '@hyperlane-xyz/utils';

import {
  WormholeChainConfigSchema,
  WormholeVaaService,
} from '../../src/services/WormholeVaaService.js';
import { initializeMetrics } from '../../src/utils/prometheus.js';
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

const iface = new ethers.utils.Interface(LOG_MESSAGE_PUBLISHED_ABI);

const ROUTES = {
  [ORIGIN_CHAIN]: {
    core: ORIGIN_CORE,
    wormholeChainId: WH_ORIGIN,
    router: ORIGIN_ROUTER,
  },
  [DESTINATION_CHAIN]: {
    core: DESTINATION_CORE,
    wormholeChainId: WH_DESTINATION,
    router: DESTINATION_ROUTER,
  },
};

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
    originDomain: ORIGIN_DOMAIN,
    destinationDomain: DESTINATION_DOMAIN,
    destinationRouter: addressToBytes32(DESTINATION_ROUTER),
    messageId,
    nonce: NONCE,
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

interface Harness {
  service: WormholeVaaService;
  getTransactionReceipt: sinon.SinonStub;
  fetchVaa: sinon.SinonStub;
  explorerLookup: sinon.SinonStub;
}

function harness(
  entries: Array<{ address: string; topics: Array<string>; data: string }>,
  vaa: string,
): Harness {
  const provider = new ethers.providers.JsonRpcProvider('http://127.0.0.1:1');
  const getTransactionReceipt = sinon
    .stub(provider, 'getTransactionReceipt')
    .resolves(toReceipt(entries));

  const multiProvider = sinon.createStubInstance(MultiProvider);
  multiProvider.getProvider.returns(provider);
  multiProvider.tryGetChainName.callsFake((domain) =>
    domain === ORIGIN_DOMAIN
      ? ORIGIN_CHAIN
      : domain === DESTINATION_DOMAIN
        ? DESTINATION_CHAIN
        : null,
  );

  const fetchVaa = sinon.stub();
  fetchVaa.resolves({ encodedVaa: vaa, vaa: parseVaa(vaa) });

  const explorerLookup = sinon.stub().resolves(TX_HASH);

  const service = new WormholeVaaService({
    serviceName: 'wormhole',
    multiProvider,
    routes: ROUTES,
    vaaFetcher: { fetchVaa },
    hyperlaneService: {
      getOriginTransactionHashByMessageId: explorerLookup,
    },
  });

  return { service, getTransactionReceipt, fetchVaa, explorerLookup };
}

const logger = pino({ level: 'silent' });

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('WormholeVaaService', () => {
  before(() => initializeMetrics(new Registry()));
  afterEach(() => sinon.restore());

  it('rejects zero Core and router addresses in route configuration', () => {
    const validRoute = ROUTES[ORIGIN_CHAIN];

    expect(
      WormholeChainConfigSchema.safeParse({
        ...validRoute,
        core: ethers.constants.AddressZero,
      }).success,
    ).to.equal(false);
    expect(
      WormholeChainConfigSchema.safeParse({
        ...validRoute,
        router: ethers.constants.AddressZero,
      }).success,
    ).to.equal(false);
  });

  it('returns the raw VAA bytes for a matching publication', async () => {
    const message = buildMessage();
    const messageId = ethers.utils.keccak256(message);
    const payload = buildPayload(messageId);
    const vaa = encodeVaa(payload);
    const { service } = harness([publicationLog(payload)], vaa);

    const result = await service.getWormholeVaa(message, TX_HASH, logger);

    expect(result).to.equal(vaa);
  });

  it('uses the relayer-provided origin transaction hash', async () => {
    const message = buildMessage();
    const payload = buildPayload(ethers.utils.keccak256(message));
    const { service, getTransactionReceipt, explorerLookup } = harness(
      [publicationLog(payload)],
      encodeVaa(payload),
    );

    await service.getWormholeVaa(message, TX_HASH, logger);

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

    await service.getWormholeVaa(message, undefined, logger);

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

    await service.getWormholeVaa(message, TX_HASH, logger);

    const [chainId, emitter, sequence] = fetchVaa.firstCall.args;
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
      service.getWormholeVaa(message, TX_HASH, logger),
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
      service.getWormholeVaa(message, TX_HASH, logger),
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
      service.getWormholeVaa(message, TX_HASH, logger),
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

    const result = await service.getWormholeVaa(message, TX_HASH, logger);

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
      service.getWormholeVaa(message, TX_HASH, logger),
      'Ambiguous receipt',
    );
  });

  it('rejects an upstream VAA whose payload differs from the publication', async () => {
    const message = buildMessage();
    const payload = buildPayload(ethers.utils.keccak256(message));
    const tampered = buildPayload(ethers.utils.id('tampered'));
    const { service } = harness([publicationLog(payload)], encodeVaa(tampered));

    await expectRejection(
      service.getWormholeVaa(message, TX_HASH, logger),
      'VAA payload does not match',
    );
  });

  it('rejects an upstream VAA from another emitter chain', async () => {
    const message = buildMessage();
    const payload = buildPayload(ethers.utils.keccak256(message));
    const { service } = harness(
      [publicationLog(payload)],
      encodeVaa(payload, { emitterChainId: WH_DESTINATION }),
    );

    await expectRejection(
      service.getWormholeVaa(message, TX_HASH, logger),
      'does not match origin',
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
    const { service } = harness(
      [],
      encodeVaa(buildPayload(ethers.utils.id('x'))),
    );

    await expectRejection(
      service.getWormholeVaa(message, TX_HASH, logger),
      'No Wormhole route configured',
    );
  });
});

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
