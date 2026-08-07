import { expect } from 'chai';
import { providers } from 'ethers';
import sinon from 'sinon';

import { test1 } from '../../consts/testChains.js';
import { ChainMetadata } from '../../metadata/chainMetadataTypes.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { contractDouble } from '../../test/contractDouble.js';

import { EvmEtherscanLikeEventLogsReader } from './EvmEventLogsReader.js';

const API_URL = 'https://api.example.com/api';
const CONTRACT_ADDRESS = '0x5d4C14B895392BD935583ebFfE0f5159540FE8bC';
const TOPIC =
  '0x6fdaf3cd8c245bcc67646386e905ab1e2e12ec4d669c2f66c2ce2e0b55e2ce74';

const TO_BLOCK = 1_000_000;

describe('EvmEtherscanLikeEventLogsReader lag window', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  // Returns the first block the RPC re-read asked for.
  async function tailStartBlockFor(
    estimateBlockTime: number | undefined,
    explorerResult: unknown = [],
    headBlock: number = TO_BLOCK,
  ): Promise<number> {
    sandbox.stub(global, 'fetch').resolves(
      contractDouble<Response>({
        url: API_URL,
        json: async () => ({
          status: '1',
          message: 'OK',
          result: explorerResult,
        }),
      }),
    );

    const blocks =
      estimateBlockTime === undefined
        ? { confirmations: 1, reorgPeriod: 0 }
        : { confirmations: 1, reorgPeriod: 0, estimateBlockTime };
    const metadata: ChainMetadata = { ...test1, blocks };
    const multiProvider = new MultiProvider({ [metadata.name]: metadata });

    const getLogs = sandbox.stub().resolves([]);
    sandbox.stub(multiProvider, 'getProvider').returns(
      contractDouble<providers.Provider>({
        getLogs,
        getBlockNumber: sandbox.stub().resolves(headBlock),
      }),
    );

    const reader = new EvmEtherscanLikeEventLogsReader(
      metadata.name,
      { apiUrl: API_URL },
      multiProvider,
    );

    await reader.getContractLogs({
      contractAddress: CONTRACT_ADDRESS,
      eventTopic: TOPIC,
      fromBlock: 0,
      toBlock: TO_BLOCK,
    });

    expect(getLogs.called).to.be.true;
    return getLogs.firstCall.args[0].fromBlock;
  }

  // As above, but for ranges that are not expected to be re-read at all.
  async function chainReadsFor(headBlock: number): Promise<number> {
    sandbox.stub(global, 'fetch').resolves(
      contractDouble<Response>({
        url: API_URL,
        json: async () => ({ status: '1', message: 'OK', result: [] }),
      }),
    );

    const multiProvider = new MultiProvider({ [test1.name]: test1 });
    const getLogs = sandbox.stub().resolves([]);
    sandbox.stub(multiProvider, 'getProvider').returns(
      contractDouble<providers.Provider>({
        getLogs,
        getBlockNumber: sandbox.stub().resolves(headBlock),
      }),
    );

    await new EvmEtherscanLikeEventLogsReader(
      test1.name,
      { apiUrl: API_URL },
      multiProvider,
    ).getContractLogs({
      contractAddress: CONTRACT_ADDRESS,
      eventTopic: TOPIC,
      fromBlock: 0,
      toBlock: TO_BLOCK,
    });

    return getLogs.callCount;
  }

  // Lag lives at the tip, so a range that ends well below it has nothing to
  // reconcile — and re-reading those blocks would require an archive node.
  it('does not read from the chain for a historical range', async () => {
    expect(await chainReadsFor(TO_BLOCK + 2_000_000)).to.equal(0);
  });

  it('reads from the chain for a range that reaches the head', async () => {
    expect(await chainReadsFor(TO_BLOCK)).to.be.greaterThan(0);
  });

  interface Case {
    name: string;
    estimateBlockTime: number | undefined;
    // Pinned rather than recomputed, so the rounding is asserted and not
    // restated. 3600s at 7s per block is 514.28…, which must round up.
    expectedBlocks: number;
  }

  const cases: Case[] = [
    { name: 'a slow chain', estimateBlockTime: 12, expectedBlocks: 300 },
    { name: 'a fast chain', estimateBlockTime: 2, expectedBlocks: 1800 },
    {
      name: 'a chain whose block time does not divide the window',
      estimateBlockTime: 7,
      expectedBlocks: 515,
    },
    // Assuming a fast chain overshoots rather than leaving lag unread.
    {
      name: 'a chain without a published block time',
      estimateBlockTime: undefined,
      expectedBlocks: 3600,
    },
    // Capped, so the re-read stays bounded on the fastest chains.
    {
      name: 'an extremely fast chain',
      estimateBlockTime: 0.2,
      expectedBlocks: 10_000,
    },
  ];

  for (const testCase of cases) {
    it(`covers the lag window on ${testCase.name}`, async () => {
      const tailStart = await tailStartBlockFor(testCase.estimateBlockTime);

      expect(TO_BLOCK - tailStart).to.equal(testCase.expectedBlocks);
    });
  }

  // The explorer's own coverage, when it reaches further than the lag window,
  // is what bounds the re-read.
  it("starts the re-read at the explorer's last record when that is later", async () => {
    const lastExplorerBlock = TO_BLOCK - 10;

    const tailStart = await tailStartBlockFor(12, [
      {
        address: CONTRACT_ADDRESS,
        blockNumber: `0x${lastExplorerBlock.toString(16)}`,
        data: '0x',
        gasPrice: '0x1',
        gasUsed: '0x1',
        logIndex: '0x0',
        timeStamp: '0x64000000',
        topics: [TOPIC],
        transactionHash: `0x${'a'.repeat(64)}`,
        transactionIndex: '0x0',
      },
    ]);

    // Without this term the scan would start a whole window back instead.
    expect(tailStart).to.equal(lastExplorerBlock);
  });

  it('reads fewer blocks the slower the chain', async () => {
    const slow = await tailStartBlockFor(12);
    sandbox.restore();
    sandbox = sinon.createSandbox();
    const fast = await tailStartBlockFor(2);

    // A fixed block count would make these equal, which is the bug this
    // derivation exists to avoid.
    expect(TO_BLOCK - slow).to.be.lessThan(TO_BLOCK - fast);
  });
});
