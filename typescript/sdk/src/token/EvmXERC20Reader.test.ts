import { expect } from 'chai';
import { BigNumber, providers, utils } from 'ethers';
import sinon from 'sinon';

import { Address, ProtocolType, assert } from '@hyperlane-xyz/utils';

import { ChainMetadata, RpcUrl } from '../metadata/chainMetadataTypes.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { HyperlaneJsonRpcProvider } from '../providers/SmartProvider/HyperlaneJsonRpcProvider.js';
import { ProviderMethod } from '../providers/SmartProvider/ProviderMethods.js';
import { EvmEventLogsReader } from '../rpc/evm/EvmEventLogsReader.js';

import { EvmXERC20Reader } from './EvmXERC20Reader.js';
import { XERC20Type } from './types.js';
import { CONFIGURATION_CHANGED_EVENT_SELECTOR } from './xerc20-abi.js';

const CHAIN_NAME = 'paginatedchain';
const CHAIN_ID = 31_337_000;
const RPC_URL = 'http://provider';
const XERC20_ADDRESS = '0x0000000000000000000000000000000000000abc';
const LATEST_BLOCK = 100;
const MAX_BLOCK_RANGE = 5;
// The xERC20 has no code before this block, which is what the deployment block
// search reads to place the lower bound of the scan.
const DEPLOYMENT_BLOCK = 8;
const CONTRACT_BYTECODE = '0x60806040';

// Configured once, early enough in the chain's history that a scan reaching
// only the most recent maxBlockRange * 10 blocks would miss it.
const BRIDGE_ONLY_EARLY = '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa';
const BRIDGE_RECENT = '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB';
const BRIDGE_DEACTIVATED = '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC';
// Configured early and reconfigured recently.
const BRIDGE_RECONFIGURED = '0xDDdDddDdDdddDDddDDddDDDDdDdDDdDDdDDDDDDd';

type BlockTag = number | 'latest' | 'earliest';

interface RawLog {
  address: string;
  blockHash: string;
  blockNumber: string;
  data: string;
  logIndex: string;
  removed: boolean;
  topics: string[];
  transactionHash: string;
  transactionIndex: string;
}

function configurationChangedLog(params: {
  bridge: Address;
  bufferCap: number;
  rateLimitPerSecond: number;
  blockNumber: number;
}): RawLog {
  return {
    address: XERC20_ADDRESS,
    blockHash: utils.hexZeroPad(utils.hexValue(params.blockNumber), 32),
    blockNumber: utils.hexValue(params.blockNumber),
    data: utils.defaultAbiCoder.encode(
      ['uint112', 'uint128'],
      [params.bufferCap, params.rateLimitPerSecond],
    ),
    logIndex: '0x0',
    removed: false,
    topics: [
      CONFIGURATION_CHANGED_EVENT_SELECTOR,
      utils.hexZeroPad(params.bridge.toLowerCase(), 32),
    ],
    transactionHash: utils.hexZeroPad(utils.hexValue(params.blockNumber), 32),
    transactionIndex: '0x0',
  };
}

const CONFIGURATION_LOGS: RawLog[] = [
  configurationChangedLog({
    bridge: BRIDGE_ONLY_EARLY,
    bufferCap: 1_000,
    rateLimitPerSecond: 10,
    blockNumber: 10,
  }),
  configurationChangedLog({
    bridge: BRIDGE_RECONFIGURED,
    bufferCap: 2_000,
    rateLimitPerSecond: 20,
    blockNumber: 20,
  }),
  configurationChangedLog({
    bridge: BRIDGE_RECENT,
    bufferCap: 3_000,
    rateLimitPerSecond: 30,
    blockNumber: 60,
  }),
  configurationChangedLog({
    bridge: BRIDGE_DEACTIVATED,
    bufferCap: 4_000,
    rateLimitPerSecond: 40,
    blockNumber: 70,
  }),
  configurationChangedLog({
    bridge: BRIDGE_RECONFIGURED,
    bufferCap: 5_000,
    rateLimitPerSecond: 50,
    blockNumber: 80,
  }),
  configurationChangedLog({
    bridge: BRIDGE_DEACTIVATED,
    bufferCap: 0,
    rateLimitPerSecond: 0,
    blockNumber: 90,
  }),
];

function decodeBlockTag(tag: unknown): BlockTag {
  if (tag === 'latest' || tag === 'earliest') return tag;
  assert(
    typeof tag === 'string',
    `Expected a hex block tag, got ${typeof tag}`,
  );
  return BigNumber.from(tag).toNumber();
}

function resolveBlockTag(tag: BlockTag): number {
  if (tag === 'latest') return LATEST_BLOCK;
  if (tag === 'earliest') return 0;
  return tag;
}

// Records the block windows the transport was asked to serve and answers each
// one with the fixture logs that fall inside it. eth_getCode is answered from
// DEPLOYMENT_BLOCK so the reader's deployment block search has something to
// converge on.
function stubTransport(): Array<[BlockTag, BlockTag]> {
  const served: Array<[BlockTag, BlockTag]> = [];
  sinon.stub(providers.JsonRpcProvider.prototype, 'perform').callsFake(
    async (
      method: string,
      params: {
        blockTag?: unknown;
        filter?: { fromBlock?: unknown; toBlock?: unknown };
      },
    ) => {
      if (method === ProviderMethod.GetBlockNumber) return LATEST_BLOCK;
      if (method === ProviderMethod.GetCode) {
        const block = resolveBlockTag(decodeBlockTag(params.blockTag));
        return block >= DEPLOYMENT_BLOCK ? CONTRACT_BYTECODE : '0x';
      }
      if (method !== ProviderMethod.GetLogs) {
        throw new Error(`Unexpected method ${method}`);
      }
      if (!params.filter) throw new Error('Missing log filter');
      const window: [BlockTag, BlockTag] = [
        decodeBlockTag(params.filter.fromBlock),
        decodeBlockTag(params.filter.toBlock),
      ];
      served.push(window);

      const fromBlock = resolveBlockTag(window[0]);
      const toBlock = resolveBlockTag(window[1]);
      return CONFIGURATION_LOGS.filter((log) => {
        const blockNumber = BigNumber.from(log.blockNumber).toNumber();
        return blockNumber >= fromBlock && blockNumber <= toBlock;
      });
    },
  );
  return served;
}

function createReader(pagination: RpcUrl['pagination']): EvmXERC20Reader {
  const metadata: ChainMetadata = {
    chainId: CHAIN_ID,
    domainId: CHAIN_ID,
    name: CHAIN_NAME,
    protocol: ProtocolType.Ethereum,
    rpcUrls: [{ http: RPC_URL, pagination }],
  };
  const multiProvider = new MultiProvider({ [CHAIN_NAME]: metadata });
  multiProvider.setProvider(
    CHAIN_NAME,
    new HyperlaneJsonRpcProvider(
      { http: RPC_URL, pagination },
      { chainId: CHAIN_ID, name: CHAIN_NAME },
    ),
  );
  return new EvmXERC20Reader(multiProvider, CHAIN_NAME);
}

describe('EvmXERC20Reader', () => {
  beforeEach(() => {
    // The chain declares no block explorer, so the reader is RPC only and any
    // fetch would be an unintended network call.
    sinon
      .stub(globalThis, 'fetch')
      .rejects(new Error('Unexpected network request'));
  });

  afterEach(() => sinon.restore());

  describe('readOnChainBridges', () => {
    interface BridgeScanCase {
      name: string;
      pagination: RpcUrl['pagination'];
      expectedWindows: Array<[BlockTag, BlockTag]>;
      expectedBridges: Address[];
    }

    const cases: BridgeScanCase[] = [
      {
        // The scan starts at the deployment block rather than block 0 and the
        // transport serves every window between it and the head, so a bridge
        // configured only in the first of them is still reported. The 93 block
        // span is refused as more sub-queries than one request issues and the
        // pagination halves it, so it arrives as two chunks of 46 blocks and
        // the trailing block, each chunk split into windows of five.
        name: 'returns bridges configured before the last maxBlockRange * 10 blocks',
        pagination: { maxBlockRange: MAX_BLOCK_RANGE },
        expectedWindows: [
          [8, 12],
          [13, 17],
          [18, 22],
          [23, 27],
          [28, 32],
          [33, 37],
          [38, 42],
          [43, 47],
          [48, 52],
          [53, 53],
          [54, 58],
          [59, 63],
          [64, 68],
          [69, 73],
          [74, 78],
          [79, 83],
          [84, 88],
          [89, 93],
          [94, 98],
          [99, 99],
          [100, 100],
        ],
        expectedBridges: [
          BRIDGE_ONLY_EARLY,
          BRIDGE_RECENT,
          BRIDGE_RECONFIGURED,
        ],
      },
      {
        name: 'returns every active bridge when the RPC declares no pagination',
        pagination: undefined,
        expectedWindows: [[8, 100]],
        expectedBridges: [
          BRIDGE_ONLY_EARLY,
          BRIDGE_RECENT,
          BRIDGE_RECONFIGURED,
        ],
      },
    ];

    for (const testCase of cases) {
      it(testCase.name, async () => {
        const served = stubTransport();
        const reader = createReader(testCase.pagination);

        const bridges = await reader.readOnChainBridges(
          XERC20_ADDRESS,
          XERC20Type.Velo,
        );

        expect(served).to.deep.equal(testCase.expectedWindows);
        expect(bridges).to.have.members(testCase.expectedBridges);
      });
    }

    it('reads the ConfigurationChanged logs with the xERC20 scan block range', async () => {
      const fromConfig = sinon.spy(EvmEventLogsReader, 'fromConfig');
      const getLogsByTopic = sinon
        .stub(EvmEventLogsReader.prototype, 'getLogsByTopic')
        .resolves([]);
      const reader = createReader({ maxBlockRange: MAX_BLOCK_RANGE });

      const bridges = await reader.readOnChainBridges(
        XERC20_ADDRESS,
        XERC20Type.Velo,
      );

      expect(bridges).to.deep.equal([]);
      expect(fromConfig.calledOnce).to.be.true;
      expect(fromConfig.firstCall.args[0]).to.deep.equal({
        chain: CHAIN_NAME,
        paginationBlockRange: 1_000_000,
      });
      expect(
        getLogsByTopic.calledOnceWithExactly({
          contractAddress: XERC20_ADDRESS,
          eventTopic: CONFIGURATION_CHANGED_EVENT_SELECTOR,
        }),
      ).to.be.true;
    });

    it('reads no logs for a Standard XERC20', async () => {
      const fromConfig = sinon.spy(EvmEventLogsReader, 'fromConfig');
      const reader = createReader({ maxBlockRange: MAX_BLOCK_RANGE });

      const bridges = await reader.readOnChainBridges(
        XERC20_ADDRESS,
        XERC20Type.Standard,
      );

      expect(bridges).to.deep.equal([]);
      expect(fromConfig.notCalled).to.be.true;
    });
  });
});
