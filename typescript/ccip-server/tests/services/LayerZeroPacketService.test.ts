import { expect } from 'chai';
import { ethers } from 'ethers';
import { pino } from 'pino';
import { Registry } from 'prom-client';
import sinon from 'sinon';

import {
  LayerZeroV2HookIsm__factory,
  Mailbox__factory,
} from '@hyperlane-xyz/core';
import {
  HyperlaneSmartProvider,
  ModuleType,
  MultiProvider,
  OnchainHookType,
} from '@hyperlane-xyz/sdk';
import { addressToBytes32, assert } from '@hyperlane-xyz/utils';

import { LayerZeroPacketService } from '../../src/services/LayerZeroPacketService.js';
import { encodeLayerZeroPayload } from '../../src/services/layerZeroPacketMatcher.js';
import { initializeMetrics } from '../../src/utils/prometheus.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ORIGIN_DOMAIN = 31338;
const DESTINATION_DOMAIN = 31347;
const ORIGIN_CHAIN = 'anvil2';
const DESTINATION_CHAIN = 'anvil3';

const ORIGIN_MAILBOX = '0x1111111111111111111111111111111111111111';
const DESTINATION_MAILBOX = '0x2222222222222222222222222222222222222222';
const ORIGIN_ENDPOINT = '0x3333333333333333333333333333333333333333';
const DESTINATION_ENDPOINT = '0x4444444444444444444444444444444444444444';
const ORIGIN_ROUTER = '0x5555555555555555555555555555555555555555';
const DESTINATION_ROUTER = '0x6666666666666666666666666666666666666666';
const SEND_LIBRARY = '0x7777777777777777777777777777777777777777';
const RECEIVE_LIBRARY = '0x8888888888888888888888888888888888888888';
const MESSAGE_SENDER = '0x9999999999999999999999999999999999999999';
const MESSAGE_RECIPIENT = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const ORIGIN_EID = 30_101;
const DESTINATION_EID = 30_110;

const NONCE = 3;
const PACKET_NONCE = 9;
const TX_HASH = `0x${'ab'.repeat(32)}`;

const routerInterface = LayerZeroV2HookIsm__factory.createInterface();
const endpointInterface = new ethers.utils.Interface([
  'function eid() view returns (uint32)',
  'function isValidReceiveLibrary(address receiver,uint32 srcEid,address receiveLibrary) view returns (bool)',
  'function getReceiveLibrary(address receiver,uint32 srcEid) view returns (address,bool)',
  'function inboundPayloadHash(address receiver,uint32 srcEid,bytes32 sender,uint64 nonce) view returns (bytes32)',
]);
const packetSentInterface = new ethers.utils.Interface([
  'event PacketSent(bytes encodedPayload,bytes options,address sendLibrary)',
]);
const mailboxInterface = Mailbox__factory.createInterface();
const receiveLibraryInterface = new ethers.utils.Interface([
  'function commitVerification(bytes packetHeader,bytes32 payloadHash)',
]);

interface LogEntry {
  address: string;
  topics: Array<string>;
  data: string;
}

interface RouterState {
  localDomain: number;
  mailbox: string;
  endpoint: string;
  eid: number;
  remoteDomain: number;
  remoteRouter: string;
  remoteEid: number;
}

const ROUTERS: Record<string, RouterState> = {
  [ORIGIN_ROUTER.toLowerCase()]: {
    localDomain: ORIGIN_DOMAIN,
    mailbox: ORIGIN_MAILBOX,
    endpoint: ORIGIN_ENDPOINT,
    eid: ORIGIN_EID,
    remoteDomain: DESTINATION_DOMAIN,
    remoteRouter: DESTINATION_ROUTER,
    remoteEid: DESTINATION_EID,
  },
  [DESTINATION_ROUTER.toLowerCase()]: {
    localDomain: DESTINATION_DOMAIN,
    mailbox: DESTINATION_MAILBOX,
    endpoint: DESTINATION_ENDPOINT,
    eid: DESTINATION_EID,
    remoteDomain: ORIGIN_DOMAIN,
    remoteRouter: ORIGIN_ROUTER,
    remoteEid: ORIGIN_EID,
  },
};

const ENDPOINT_EIDS: Record<string, number> = {
  [ORIGIN_ENDPOINT.toLowerCase()]: ORIGIN_EID,
  [DESTINATION_ENDPOINT.toLowerCase()]: DESTINATION_EID,
};

function buildMessage(originDomain = ORIGIN_DOMAIN): string {
  return ethers.utils.solidityPack(
    ['uint8', 'uint32', 'uint32', 'bytes32', 'uint32', 'bytes32', 'bytes'],
    [
      3,
      NONCE,
      originDomain,
      addressToBytes32(MESSAGE_SENDER),
      DESTINATION_DOMAIN,
      addressToBytes32(MESSAGE_RECIPIENT),
      ethers.utils.toUtf8Bytes('hello'),
    ],
  );
}

function buildPacket(message: string, nonce = PACKET_NONCE): string {
  const sender = addressToBytes32(ORIGIN_ROUTER);
  const receiver = addressToBytes32(DESTINATION_ROUTER);
  const guid = ethers.utils.solidityKeccak256(
    ['uint64', 'uint32', 'bytes32', 'uint32', 'bytes32'],
    [nonce, ORIGIN_EID, sender, DESTINATION_EID, receiver],
  );
  return ethers.utils.solidityPack(
    [
      'uint8',
      'uint64',
      'uint32',
      'bytes32',
      'uint32',
      'bytes32',
      'bytes32',
      'bytes',
    ],
    [
      1,
      nonce,
      ORIGIN_EID,
      sender,
      DESTINATION_EID,
      receiver,
      guid,
      encodeLayerZeroPayload(
        ORIGIN_DOMAIN,
        DESTINATION_DOMAIN,
        ethers.utils.keccak256(message),
      ),
    ],
  );
}

function packetSentLog(packet: string, address = ORIGIN_ENDPOINT): LogEntry {
  const encoded = packetSentInterface.encodeEventLog(
    packetSentInterface.getEvent('PacketSent'),
    [packet, '0x0003', SEND_LIBRARY],
  );
  return { address, topics: encoded.topics, data: encoded.data };
}

function dispatchLog(message: string): LogEntry {
  const encoded = mailboxInterface.encodeEventLog(
    mailboxInterface.getEvent('Dispatch'),
    [
      MESSAGE_SENDER,
      DESTINATION_DOMAIN,
      addressToBytes32(MESSAGE_RECIPIENT),
      message,
    ],
  );
  return {
    address: ORIGIN_MAILBOX,
    topics: encoded.topics,
    data: encoded.data,
  };
}

/** A `Log` shaped exactly as ethers returns it from a receipt. */
function toLog(entry: LogEntry, logIndex: number): ethers.providers.Log {
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
  entries: Array<LogEntry>,
  status = 1,
): ethers.providers.TransactionReceipt {
  return {
    to: ORIGIN_ROUTER,
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
    status,
  };
}

function routerCall(router: RouterState, data: string): string {
  const call = routerInterface.parseTransaction({ data });
  const results: Record<string, unknown> = {
    mailbox: router.mailbox,
    endpointContract: router.endpoint,
    localDomain: router.localDomain,
    localEndpointId: router.eid,
    hookType: OnchainHookType.LAYER_ZERO,
    moduleType: ModuleType.CCIP_READ,
    routers: addressToBytes32(router.remoteRouter),
    remoteLzEndpointIds: router.remoteEid,
  };
  assert(call.name in results, `Unexpected router call ${call.name}`);
  return routerInterface.encodeFunctionResult(call.functionFragment, [
    results[call.name],
  ]);
}

function endpointCall(eid: number, data: string): string {
  const call = endpointInterface.parseTransaction({ data });
  switch (call.name) {
    case 'eid':
      return endpointInterface.encodeFunctionResult(call.functionFragment, [
        eid,
      ]);
    case 'getReceiveLibrary':
      return endpointInterface.encodeFunctionResult(call.functionFragment, [
        RECEIVE_LIBRARY,
        false,
      ]);
    case 'isValidReceiveLibrary':
      return endpointInterface.encodeFunctionResult(call.functionFragment, [
        true,
      ]);
    case 'inboundPayloadHash':
      return endpointInterface.encodeFunctionResult(call.functionFragment, [
        ethers.constants.HashZero,
      ]);
    default:
      throw new Error(`Unexpected Endpoint call ${call.name}`);
  }
}

interface Harness {
  service: LayerZeroPacketService;
  getTransactionReceipt: sinon.SinonStub;
  explorerLookup: sinon.SinonStub;
  rpcSends: Array<sinon.SinonStub>;
}

/**
 * `rpcReady` lists, per RPC provider behind the smart provider, whether that
 * RPC accepts the commitVerification simulation.
 */
function harness(
  entries: Array<LogEntry>,
  options: { status?: number; rpcReady?: Array<boolean> } = {},
): Harness {
  const rpcReady = options.rpcReady ?? [true, true];
  const provider = new HyperlaneSmartProvider(
    ORIGIN_DOMAIN,
    rpcReady.map((_, index) => ({ http: `http://127.0.0.1:${index + 1}` })),
  );
  const rpcSends = provider.rpcProviders.map((rpcProvider, index) =>
    rpcReady[index]
      ? sinon.stub(rpcProvider, 'send').resolves('0x')
      : sinon.stub(rpcProvider, 'send').rejects(new Error('DVNs pending')),
  );
  const getTransactionReceipt = sinon
    .stub(provider, 'getTransactionReceipt')
    .resolves(toReceipt(entries, options.status));
  sinon.stub(provider, 'call').callsFake(async (transaction) => {
    const { to, data } = await ethers.utils.resolveProperties(transaction);
    assert(
      typeof to === 'string' && typeof data === 'string',
      'Malformed eth_call',
    );
    const router = ROUTERS[to.toLowerCase()];
    if (router) return routerCall(router, data);
    const eid = ENDPOINT_EIDS[to.toLowerCase()];
    if (eid !== undefined) return endpointCall(eid, data);
    throw new Error(`Unexpected eth_call to ${to}`);
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

  const service = new LayerZeroPacketService({
    serviceName: 'layerzero',
    multiProvider,
    hyperlaneService: {
      getOriginTransactionHashByMessageId: explorerLookup,
    },
  });

  return { service, getTransactionReceipt, explorerLookup, rpcSends };
}

const logger = pino({ level: 'silent' });

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('LayerZeroPacketService', () => {
  before(() => initializeMetrics(new Registry()));
  afterEach(() => sinon.restore());

  it('returns the receive library and packet for a matching dispatch', async () => {
    const message = buildMessage();
    const packet = buildPacket(message);
    const { service } = harness([dispatchLog(message), packetSentLog(packet)]);

    const result = await service.getLayerZeroPacket(
      message,
      DESTINATION_ROUTER,
      TX_HASH,
      logger,
    );

    expect(result).to.deep.equal([RECEIVE_LIBRARY, packet]);
  });

  it('uses the relayer-provided origin transaction hash', async () => {
    const message = buildMessage();
    const { service, getTransactionReceipt, explorerLookup } = harness([
      dispatchLog(message),
      packetSentLog(buildPacket(message)),
    ]);

    await service.getLayerZeroPacket(
      message,
      DESTINATION_ROUTER,
      TX_HASH,
      logger,
    );

    expect(getTransactionReceipt.calledOnceWith(TX_HASH)).to.be.true;
    expect(explorerLookup.called).to.be.false;
  });

  it('falls back to the Explorer when the relayer sends no tx hash', async () => {
    const message = buildMessage();
    const { service, explorerLookup, getTransactionReceipt } = harness([
      dispatchLog(message),
      packetSentLog(buildPacket(message)),
    ]);

    await service.getLayerZeroPacket(
      message,
      DESTINATION_ROUTER,
      undefined,
      logger,
    );

    expect(explorerLookup.calledOnceWith(ethers.utils.keccak256(message))).to.be
      .true;
    expect(getTransactionReceipt.calledOnceWith(TX_HASH)).to.be.true;
  });

  it('rejects a receipt with no LayerZero packet', async () => {
    const message = buildMessage();
    const { service } = harness([dispatchLog(message)]);

    await expectRejection(
      service.getLayerZeroPacket(message, DESTINATION_ROUTER, TX_HASH, logger),
      'No matching LayerZero packet in origin receipt',
    );
  });

  it('ignores a lookalike packet from a non-Endpoint address', async () => {
    const message = buildMessage();
    const { service } = harness([
      dispatchLog(message),
      packetSentLog(buildPacket(message), DESTINATION_ENDPOINT),
    ]);

    await expectRejection(
      service.getLayerZeroPacket(message, DESTINATION_ROUTER, TX_HASH, logger),
      'No matching LayerZero packet in origin receipt',
    );
  });

  it('disambiguates when the receipt holds several packets', async () => {
    const message = buildMessage();
    const packet = buildPacket(message);
    const other = buildPacket(buildMessage(ORIGIN_DOMAIN + 1), 8);
    const { service } = harness([
      dispatchLog(message),
      packetSentLog(other),
      packetSentLog(packet),
    ]);

    const [, result] = await service.getLayerZeroPacket(
      message,
      DESTINATION_ROUTER,
      TX_HASH,
      logger,
    );

    expect(result).to.equal(packet);
  });

  it('rejects an ambiguous receipt with two packets for one message', async () => {
    const message = buildMessage();
    const { service } = harness([
      dispatchLog(message),
      packetSentLog(buildPacket(message)),
      packetSentLog(buildPacket(message, PACKET_NONCE + 1)),
    ]);

    await expectRejection(
      service.getLayerZeroPacket(message, DESTINATION_ROUTER, TX_HASH, logger),
      'Ambiguous LayerZero packets in origin receipt',
    );
  });

  it('rejects a receipt without the exact Mailbox dispatch', async () => {
    const message = buildMessage();
    const { service } = harness([packetSentLog(buildPacket(message))]);

    await expectRejection(
      service.getLayerZeroPacket(message, DESTINATION_ROUTER, TX_HASH, logger),
      'Expected one exact Hyperlane Dispatch event, found 0',
    );
  });

  it('rejects a reverted origin transaction', async () => {
    const message = buildMessage();
    const { service } = harness(
      [dispatchLog(message), packetSentLog(buildPacket(message))],
      { status: 0 },
    );

    await expectRejection(
      service.getLayerZeroPacket(message, DESTINATION_ROUTER, TX_HASH, logger),
      `Origin transaction ${TX_HASH} reverted`,
    );
  });

  it('simulates the commitment with a raw eth_call on the first RPC', async () => {
    const message = buildMessage();
    const packet = buildPacket(message);
    const { service, rpcSends } = harness([
      dispatchLog(message),
      packetSentLog(packet),
    ]);

    await service.getLayerZeroPacket(
      message,
      DESTINATION_ROUTER,
      TX_HASH,
      logger,
    );

    const [first, second] = rpcSends;
    expect(first.calledOnce).to.be.true;
    expect(second.called).to.be.false;
    const [method, [transaction, blockTag]] = first.firstCall.args;
    expect(method).to.equal('eth_call');
    expect(blockTag).to.equal('latest');
    expect(transaction.to).to.equal(RECEIVE_LIBRARY);
    const [header, payloadHash] = receiveLibraryInterface.decodeFunctionData(
      'commitVerification',
      transaction.data,
    );
    expect(header).to.equal(ethers.utils.hexDataSlice(packet, 0, 81));
    expect(payloadHash).to.equal(
      ethers.utils.keccak256(ethers.utils.hexDataSlice(packet, 81)),
    );
  });

  it('falls through to the next RPC when a commitment simulation fails', async () => {
    const message = buildMessage();
    const packet = buildPacket(message);
    const { service, rpcSends } = harness(
      [dispatchLog(message), packetSentLog(packet)],
      { rpcReady: [false, true] },
    );

    const result = await service.getLayerZeroPacket(
      message,
      DESTINATION_ROUTER,
      TX_HASH,
      logger,
    );

    expect(result).to.deep.equal([RECEIVE_LIBRARY, packet]);
    expect(rpcSends.every((send) => send.calledOnce)).to.be.true;
  });

  it('rejects a packet whose DVNs have not verified it on any RPC', async () => {
    const message = buildMessage();
    const { service } = harness(
      [dispatchLog(message), packetSentLog(buildPacket(message))],
      { rpcReady: [false, false] },
    );

    await expectRejection(
      service.getLayerZeroPacket(message, DESTINATION_ROUTER, TX_HASH, logger),
      'LayerZero packet is not DVN-ready: Error: DVNs pending',
    );
  });

  it('rejects a message whose origin chain has no configured route', async () => {
    const message = buildMessage(999_999);
    const { service, getTransactionReceipt } = harness([]);

    await expectRejection(
      service.getLayerZeroPacket(message, DESTINATION_ROUTER, TX_HASH, logger),
      'Unknown Hyperlane origin domain 999999',
    );
    expect(getTransactionReceipt.called).to.be.false;
  });

  it('rejects a CCIP sender that is not the destination router', async () => {
    const message = buildMessage();
    const { service, getTransactionReceipt } = harness([
      dispatchLog(message),
      packetSentLog(buildPacket(message)),
    ]);

    await expectRejection(
      service.getLayerZeroPacket(message, ORIGIN_ROUTER, TX_HASH, logger),
      `LayerZero router ${ORIGIN_ROUTER} reports Hyperlane domain ${ORIGIN_DOMAIN}; expected ${DESTINATION_DOMAIN}`,
    );
    expect(getTransactionReceipt.called).to.be.false;
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
