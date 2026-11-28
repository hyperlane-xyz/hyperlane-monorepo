import { expect } from 'chai';
import { providers } from 'ethers';
import sinon from 'sinon';

import { BlacklistIsm, BlacklistIsm__factory } from '@hyperlane-xyz/core';
import { assert } from '@hyperlane-xyz/utils';

import { TestChainName, test1 } from '../consts/testChains.js';
import { EthJsonRpcBlockParameterTag } from '../metadata/chainMetadataTypes.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { HyperlaneSmartProvider } from '../providers/SmartProvider/SmartProvider.js';
import {
  EvmEtherscanLikeEventLogsReader,
  EvmEventLogsReader,
} from '../rpc/evm/EvmEventLogsReader.js';
import { GetEventLogsResponse } from '../rpc/evm/types.js';
import { contractDouble } from '../test/contractDouble.js';
import { missingSelectorError, networkError } from '../test/errors.js';

import { readBlacklistedIds } from './blacklist.js';

const MESSAGE_BLACKLISTED_TOPIC =
  BlacklistIsm__factory.createInterface().getEventTopic('MessageBlacklisted');
const BLACKLIST_ADDRESS = '0x5d4C14B895392BD935583ebFfE0f5159540FE8bC';
const BLACKLISTED_ID = `0x${'11'.repeat(32)}`;
const EARLY_BLACKLISTED_ID = `0x${'22'.repeat(32)}`;
const LATE_BLACKLISTED_ID = `0x${'33'.repeat(32)}`;
const DEPLOYMENT_BLOCK = 100;
const FINALIZED_BLOCK = 456;
const NETWORK = { chainId: test1.domainId, name: TestChainName.test1 };

type ServedRange = { fromBlock: number; toBlock: number };

function messageBlacklistedLog(
  messageId = BLACKLISTED_ID,
  blockNumber = 120,
): GetEventLogsResponse {
  return {
    address: BLACKLIST_ADDRESS,
    blockNumber,
    data: '0x',
    logIndex: 0,
    topics: [MESSAGE_BLACKLISTED_TOPIC, messageId],
    transactionHash: `0x${'ab'.repeat(32)}`,
    transactionIndex: 0,
  };
}

function rpcMessageBlacklistedLog(
  messageId: string,
  blockNumber: number,
): providers.Log {
  return {
    ...messageBlacklistedLog(messageId, blockNumber),
    blockHash: `0x${'cd'.repeat(32)}`,
    removed: false,
  };
}

function blockWindow(filter: unknown): ServedRange {
  if (typeof filter !== 'object' || filter === null) {
    throw new Error('Expected log filter object');
  }
  const fromBlock: unknown = Reflect.get(filter, 'fromBlock');
  const toBlock: unknown = Reflect.get(filter, 'toBlock');
  if (typeof fromBlock !== 'number' || typeof toBlock !== 'number') {
    throw new Error('Expected numeric block bounds on the log filter');
  }
  return { fromBlock, toBlock };
}

function spanOf({ fromBlock, toBlock }: ServedRange): number {
  return toBlock - fromBlock + 1;
}

function blockInRange(blockNumber: number, range: ServedRange): boolean {
  return blockNumber >= range.fromBlock && blockNumber <= range.toBlock;
}

function expectFullCoverage(
  served: ServedRange[],
  fromBlock: number,
  toBlock: number,
): void {
  expect(served[0].fromBlock).to.equal(fromBlock);
  expect(served[served.length - 1].toBlock).to.equal(toBlock);
  for (let i = 1; i < served.length; i++) {
    expect(served[i].fromBlock).to.equal(served[i - 1].toBlock + 1);
  }
}

const FINALIZED_BLOCK_HEX = '0x1c8';

describe('readBlacklistedIds', () => {
  let sandbox: sinon.SinonSandbox;
  let multiProvider: MultiProvider;
  let provider: providers.StaticJsonRpcProvider;
  let send: sinon.SinonStub;
  let getLogsByTopic: sinon.SinonStub;
  let getContractDeploymentBlockFromExplorer: sinon.SinonStub;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    provider = new providers.StaticJsonRpcProvider(
      'http://127.0.0.1:1',
      NETWORK,
    );
    multiProvider = MultiProvider.createTestMultiProvider({ provider });
    send = sandbox
      .stub(provider, 'send')
      .resolves({ number: FINALIZED_BLOCK_HEX });
    getContractDeploymentBlockFromExplorer = sandbox
      .stub(
        EvmEventLogsReader.prototype,
        'getContractDeploymentBlockFromExplorer',
      )
      .resolves(DEPLOYMENT_BLOCK);
    getLogsByTopic = sandbox
      .stub(EvmEventLogsReader.prototype, 'getLogsByTopic')
      .resolves([messageBlacklistedLog()]);
  });

  afterEach(() => {
    sandbox.restore();
  });

  function connectBlacklist(values: sinon.SinonStub): void {
    sandbox
      .stub(BlacklistIsm__factory, 'connect')
      .returns(contractDouble<BlacklistIsm>({ values }));
  }

  function nonRecoverableError(message: string) {
    return Object.assign(new Error(message), { isRecoverable: false });
  }

  function realGenesisReader(paginationBlockRange: number): EvmEventLogsReader {
    getLogsByTopic.restore();
    getContractDeploymentBlockFromExplorer.restore();
    sandbox
      .stub(
        EvmEtherscanLikeEventLogsReader.prototype,
        'getContractDeploymentBlockNumber',
      )
      .rejects(nonRecoverableError('explorer deployment lookup failed'));
    sandbox
      .stub(EvmEtherscanLikeEventLogsReader.prototype, 'getContractLogs')
      .rejects(nonRecoverableError('explorer logs failed'));
    sandbox.stub(provider, 'getCode').resolves('0x01');
    return EvmEventLogsReader.fromConfig(
      { chain: TestChainName.test1, paginationBlockRange },
      multiProvider,
    );
  }

  interface EnumerableCase {
    name: string;
    blockTag?: number | EthJsonRpcBlockParameterTag;
    overrides: { blockTag?: number | string };
  }
  const enumerableCases: EnumerableCase[] = [
    { name: 'at the latest block by default', overrides: {} },
    {
      name: 'at a numeric block tag',
      blockTag: 1234,
      overrides: { blockTag: 1234 },
    },
    {
      name: 'at a named block tag',
      blockTag: EthJsonRpcBlockParameterTag.Finalized,
      overrides: { blockTag: 'finalized' },
    },
  ];
  for (const c of enumerableCases) {
    it(`reads values() ${c.name}`, async () => {
      const values = sandbox.stub().resolves([BLACKLISTED_ID]);
      connectBlacklist(values);

      const ids = await readBlacklistedIds(
        TestChainName.test1,
        BLACKLIST_ADDRESS,
        multiProvider,
        undefined,
        c.blockTag,
      );

      expect(ids).to.deep.equal([BLACKLISTED_ID]);
      expect(values.calledOnce).to.be.true;
      expect(values.firstCall.args).to.deep.equal([c.overrides]);
      expect(getLogsByTopic.called).to.be.false;
      expect(send.called).to.be.false;
    });
  }

  interface LegacyQuery {
    contractAddress: string;
    eventTopic: string;
    fromBlock: number;
    toBlock?: number;
  }
  interface LegacyCase {
    name: string;
    blockTag?: number | EthJsonRpcBlockParameterTag;
    query: LegacyQuery;
    resolvedTag?: string;
  }
  const legacyCases: LegacyCase[] = [
    {
      name: 'up to the latest block by default',
      query: {
        contractAddress: BLACKLIST_ADDRESS,
        eventTopic: MESSAGE_BLACKLISTED_TOPIC,
        fromBlock: DEPLOYMENT_BLOCK,
      },
    },
    {
      name: 'up to a numeric block tag',
      blockTag: 1234,
      query: {
        contractAddress: BLACKLIST_ADDRESS,
        eventTopic: MESSAGE_BLACKLISTED_TOPIC,
        fromBlock: DEPLOYMENT_BLOCK,
        toBlock: 1234,
      },
    },
    {
      name: 'up to the block a named block tag resolves to',
      blockTag: EthJsonRpcBlockParameterTag.Finalized,
      query: {
        contractAddress: BLACKLIST_ADDRESS,
        eventTopic: MESSAGE_BLACKLISTED_TOPIC,
        fromBlock: DEPLOYMENT_BLOCK,
        toBlock: FINALIZED_BLOCK,
      },
      resolvedTag: 'finalized',
    },
  ];
  for (const c of legacyCases) {
    it(`replays the logs of a legacy deployment ${c.name}`, async () => {
      connectBlacklist(sandbox.stub().rejects(missingSelectorError()));

      const ids = await readBlacklistedIds(
        TestChainName.test1,
        BLACKLIST_ADDRESS,
        multiProvider,
        undefined,
        c.blockTag,
      );

      expect(ids).to.deep.equal([BLACKLISTED_ID]);
      expect(getLogsByTopic.calledOnce).to.be.true;
      expect(getLogsByTopic.firstCall.args).to.deep.equal([c.query]);
      expect(send.getCalls().map((call) => call.args)).to.deep.equal(
        c.resolvedTag ? [['eth_getBlockByNumber', [c.resolvedTag, false]]] : [],
      );
    });
  }

  it('scans from genesis when the explorer deployment block is unavailable', async () => {
    getContractDeploymentBlockFromExplorer.rejects(
      new Error('No block explorer is configured for chain test1'),
    );
    connectBlacklist(sandbox.stub().rejects(missingSelectorError()));

    const ids = await readBlacklistedIds(
      TestChainName.test1,
      BLACKLIST_ADDRESS,
      multiProvider,
    );

    expect(ids).to.deep.equal([BLACKLISTED_ID]);
    expect(getLogsByTopic.calledOnce).to.be.true;
    expect(getLogsByTopic.firstCall.args).to.deep.equal([
      {
        contractAddress: BLACKLIST_ADDRESS,
        eventTopic: MESSAGE_BLACKLISTED_TOPIC,
        fromBlock: 0,
      },
    ]);
  });

  it('scans genesis through RPC fallback with no pagination gap', async () => {
    const latestBlock = 25;
    const providerCap = 10;
    const reader = realGenesisReader(20);
    const requested: ServedRange[] = [];
    const served: ServedRange[] = [];
    sandbox.stub(provider, 'getBlockNumber').resolves(latestBlock);
    sandbox.stub(provider, 'getLogs').callsFake(async (filter) => {
      const range = blockWindow(await filter);
      requested.push(range);
      if (spanOf(range) > providerCap) {
        throw new Error('query returned more than 10000 results');
      }
      served.push(range);

      const logs: providers.Log[] = [];
      if (blockInRange(3, range)) {
        logs.push(rpcMessageBlacklistedLog(EARLY_BLACKLISTED_ID, 3));
      }
      if (blockInRange(23, range)) {
        logs.push(rpcMessageBlacklistedLog(LATE_BLACKLISTED_ID, 23));
      }
      return logs;
    });
    connectBlacklist(sandbox.stub().rejects(missingSelectorError()));

    const ids = await readBlacklistedIds(
      TestChainName.test1,
      BLACKLIST_ADDRESS,
      multiProvider,
      reader,
    );

    expect(ids).to.deep.equal([EARLY_BLACKLISTED_ID, LATE_BLACKLISTED_ID]);
    expect(requested).to.deep.equal([
      { fromBlock: 0, toBlock: 19 },
      { fromBlock: 0, toBlock: 9 },
      { fromBlock: 10, toBlock: 19 },
      { fromBlock: 20, toBlock: 25 },
    ]);
    expectFullCoverage(served, 0, latestBlock);
  });

  it('fails closed when a later RPC pagination range fails', async () => {
    const reader = realGenesisReader(10);
    const requested: ServedRange[] = [];
    sandbox.stub(provider, 'getBlockNumber').resolves(25);
    sandbox.stub(provider, 'getLogs').callsFake(async (filter) => {
      const range = blockWindow(await filter);
      requested.push(range);
      if (range.fromBlock === 10) {
        throw Object.assign(new Error('unauthorized'), { status: 401 });
      }
      return blockInRange(3, range)
        ? [rpcMessageBlacklistedLog(EARLY_BLACKLISTED_ID, 3)]
        : [];
    });
    connectBlacklist(sandbox.stub().rejects(missingSelectorError()));

    let ids: string[] | undefined;
    let thrown: unknown;
    try {
      ids = await readBlacklistedIds(
        TestChainName.test1,
        BLACKLIST_ADDRESS,
        multiProvider,
        reader,
      );
    } catch (error: unknown) {
      thrown = error;
    }

    expect(ids).to.equal(undefined);
    assert(thrown instanceof Error, 'expected the read to fail');
    expect(thrown.message).to.include('rebuilding the set');
    assert(thrown.cause instanceof Error, 'expected an error cause');
    expect(thrown.cause.message).to.equal('unauthorized');
    expect(requested).to.deep.equal([
      { fromBlock: 0, toBlock: 9 },
      { fromBlock: 10, toBlock: 19 },
    ]);
  });

  it('returns no ids for a legacy deployment made after the block tag', async () => {
    connectBlacklist(sandbox.stub().rejects(missingSelectorError()));

    const ids = await readBlacklistedIds(
      TestChainName.test1,
      BLACKLIST_ADDRESS,
      multiProvider,
      undefined,
      DEPLOYMENT_BLOCK - 1,
    );

    expect(ids).to.deep.equal([]);
    expect(getLogsByTopic.called).to.be.false;
  });

  it('resolves a named block tag through the smart provider', async () => {
    const smartProvider = HyperlaneSmartProvider.fromRpcUrl(
      NETWORK,
      'http://127.0.0.1:1',
    );
    const sendReadRpc = sandbox
      .stub(smartProvider, 'sendReadRpc')
      .resolves({ number: FINALIZED_BLOCK_HEX });
    connectBlacklist(sandbox.stub().rejects(missingSelectorError()));

    await readBlacklistedIds(
      TestChainName.test1,
      BLACKLIST_ADDRESS,
      MultiProvider.createTestMultiProvider({ provider: smartProvider }),
      undefined,
      EthJsonRpcBlockParameterTag.Finalized,
    );

    expect(sendReadRpc.getCalls().map((call) => call.args)).to.deep.equal([
      ['eth_getBlockByNumber', ['finalized', false]],
    ]);
    expect(getLogsByTopic.firstCall.args[0].toBlock).to.equal(FINALIZED_BLOCK);
  });

  interface UnresolvableCase {
    name: string;
    stub: (send: sinon.SinonStub) => void;
    cause: string;
  }
  const unresolvableCases: UnresolvableCase[] = [
    {
      name: 'the RPC does not know the block tag',
      stub: (stub) => stub.resolves(null),
      cause:
        'Block tag "finalized" not supported by RPC provider for chain test1',
    },
    {
      name: 'the block number is not a hex quantity',
      stub: (stub) => stub.resolves({ number: '456' }),
      cause:
        'Invalid block number for block tag "finalized" on chain test1: 456',
    },
    {
      name: 'the block request fails',
      stub: (stub) => stub.rejects(networkError()),
      cause: 'provider unavailable',
    },
  ];
  for (const c of unresolvableCases) {
    it(`fails when ${c.name}`, async () => {
      connectBlacklist(sandbox.stub().rejects(missingSelectorError()));
      c.stub(send);

      let thrown: unknown;
      try {
        await readBlacklistedIds(
          TestChainName.test1,
          BLACKLIST_ADDRESS,
          multiProvider,
          undefined,
          EthJsonRpcBlockParameterTag.Finalized,
        );
      } catch (error: unknown) {
        thrown = error;
      }

      assert(thrown instanceof Error, 'expected the read to fail');
      expect(thrown.message).to.include(BLACKLIST_ADDRESS);
      assert(thrown.cause instanceof Error, 'expected an error cause');
      expect(thrown.cause.message).to.equal(c.cause);
      expect(getLogsByTopic.called).to.be.false;
    });
  }
});
