import { expect } from 'chai';
import { providers } from 'ethers';
import sinon from 'sinon';

import { BlacklistIsm, BlacklistIsm__factory } from '@hyperlane-xyz/core';
import { assert } from '@hyperlane-xyz/utils';

import { TestChainName, test1 } from '../consts/testChains.js';
import { EthJsonRpcBlockParameterTag } from '../metadata/chainMetadataTypes.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { HyperlaneSmartProvider } from '../providers/SmartProvider/SmartProvider.js';
import { EvmEventLogsReader } from '../rpc/evm/EvmEventLogsReader.js';
import { GetEventLogsResponse } from '../rpc/evm/types.js';
import { contractDouble } from '../test/contractDouble.js';
import { missingSelectorError, networkError } from '../test/errors.js';

import { readBlacklistedIds } from './blacklist.js';

const MESSAGE_BLACKLISTED_TOPIC =
  BlacklistIsm__factory.createInterface().getEventTopic('MessageBlacklisted');
const BLACKLIST_ADDRESS = '0x5d4C14B895392BD935583ebFfE0f5159540FE8bC';
const BLACKLISTED_ID = `0x${'11'.repeat(32)}`;
const DEPLOYMENT_BLOCK = 100;
const FINALIZED_BLOCK = 456;
const NETWORK = { chainId: test1.domainId, name: TestChainName.test1 };

function messageBlacklistedLog(): GetEventLogsResponse {
  return {
    address: BLACKLIST_ADDRESS,
    blockNumber: 120,
    data: '0x',
    logIndex: 0,
    topics: [MESSAGE_BLACKLISTED_TOPIC, BLACKLISTED_ID],
    transactionHash: `0x${'ab'.repeat(32)}`,
    transactionIndex: 0,
  };
}

const FINALIZED_BLOCK_HEX = '0x1c8';

describe('readBlacklistedIds', () => {
  let sandbox: sinon.SinonSandbox;
  let multiProvider: MultiProvider;
  let provider: providers.StaticJsonRpcProvider;
  let send: sinon.SinonStub;
  let getLogsByTopic: sinon.SinonStub;

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
    sandbox
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
