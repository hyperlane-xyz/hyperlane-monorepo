import { JsonRpcProvider } from '@ethersproject/providers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { ethers } from 'ethers';
import hre from 'hardhat';
import sinon from 'sinon';

import { ERC20Test, ERC20Test__factory } from '@hyperlane-xyz/core';
import { assert } from '@hyperlane-xyz/utils';

import {
  KNOWN_ETHEREUM_TIMELOCK_CONTRACT,
  TestChainName,
  ethereumTestChain,
  test1,
} from '../../consts/testChains.js';
import { ExplorerFamily } from '../../metadata/chainMetadataTypes.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { randomAddress, randomInt } from '../../test/testUtils.js';

import {
  EvmEtherscanLikeEventLogsReader,
  EvmEventLogsReader,
  EvmRpcEventLogsReader,
  FallbackEvmEventLogsReader,
} from './EvmEventLogsReader.js';
import { GetEventLogsResponse } from './types.js';

chai.use(chaiAsPromised);

describe('EvmEventLogsReader', () => {
  let contractOwner: SignerWithAddress;
  let tokenRecipient1: SignerWithAddress;
  let tokenRecipient2: SignerWithAddress;
  let providerChainTest1: JsonRpcProvider;
  let multiProvider: MultiProvider;
  let testContract: ERC20Test;
  let erc20Factory: ERC20Test__factory;
  let deploymentBlockNumber: number;

  const transferTopic = ethers.utils.id('Transfer(address,address,uint256)');

  beforeEach(async () => {
    [contractOwner, tokenRecipient1, tokenRecipient2] =
      await hre.ethers.getSigners();

    assert(contractOwner.provider, 'Provider should be available');

    // Initialize MultiProvider with test chain
    multiProvider = MultiProvider.createTestMultiProvider({
      signer: contractOwner,
      provider: contractOwner.provider,
    });
    providerChainTest1 = contractOwner.provider as JsonRpcProvider;

    // Get contract factory for ERC20Test
    erc20Factory = new ERC20Test__factory(contractOwner);
  });

  afterEach(() => sinon.restore());

  async function deployTestErc20() {
    testContract = await erc20Factory.deploy(
      'TestToken',
      'TST',
      ethers.utils.parseEther('1000000'),
      18,
    );

    await testContract.deployed();
    assert(
      testContract.deployTransaction.blockNumber,
      'Expected the Contract deployment block number to be defined',
    );
    deploymentBlockNumber = testContract.deployTransaction.blockNumber;
  }

  async function mineRandomNumberOfBlocks() {
    const blocksToMine = randomInt(5, 20);
    for (let blockNum = 0; blockNum < blocksToMine; blockNum++) {
      await providerChainTest1.send('evm_mine', []);
    }
  }

  describe('constructor', () => {
    it('should initialize with BlockExplorer strategy when useRPC is false', async () => {
      const readerWithRpc = EvmEventLogsReader.fromConfig(
        {
          chain: TestChainName.test1,
        },
        multiProvider,
      );

      // Access the private property indirectly
      expect(readerWithRpc['logReaderStrategy']).to.be.instanceOf(
        FallbackEvmEventLogsReader,
      );
    });

    it('should initialize with RPC strategy when useRPC is true', async () => {
      const readerWithRpc = EvmEventLogsReader.fromConfig(
        {
          chain: TestChainName.test1,
          useRPC: true,
        },
        multiProvider,
      );

      // Access the private property indirectly
      expect(readerWithRpc['logReaderStrategy']).to.be.instanceOf(
        EvmRpcEventLogsReader,
      );
    });

    it('should initialize with RPC strategy when no explorer is available', async () => {
      const multiProviderNoExplorer = new MultiProvider({});
      multiProviderNoExplorer.setSharedSigner(contractOwner);

      const reader = EvmEventLogsReader.fromConfig(
        {
          chain: TestChainName.test1,
          // Even when false, should use RPC if no explorer
          useRPC: false,
        },
        multiProviderNoExplorer,
      );

      // Access the private property indirectly
      expect(reader['logReaderStrategy']).to.be.instanceOf(
        EvmRpcEventLogsReader,
      );
    });

    it('should allow explorer fallback to be enabled per method', async () => {
      const firstReader = new EvmEtherscanLikeEventLogsReader(
        TestChainName.test1,
        {
          apiKey: 'first-key',
          apiUrl: 'https://first.example.com/api',
          family: ExplorerFamily.Etherscan,
        },
        multiProvider,
      );
      const secondReader = new EvmEtherscanLikeEventLogsReader(
        TestChainName.test1,
        {
          apiUrl: 'https://second.example.com/api',
          family: ExplorerFamily.Blockscout,
        },
        multiProvider,
      );
      const firstGetLogs = sinon
        .stub(firstReader, 'getContractLogs')
        .rejects(new Error('first explorer failed'));
      const secondGetLogs = sinon
        .stub(secondReader, 'getContractLogs')
        .resolves([]);
      const reader = new FallbackEvmEventLogsReader(
        TestChainName.test1,
        [firstReader, secondReader],
        multiProvider.logger,
        {
          getContractLogs: true,
        },
      );

      expect(
        await reader.getContractLogs({
          contractAddress: randomAddress(),
          eventTopic: ethers.constants.HashZero,
          fromBlock: 0,
          toBlock: 0,
        }),
      ).to.deep.equal([]);
      expect(firstGetLogs.calledOnce).to.be.true;
      expect(secondGetLogs.calledOnce).to.be.true;
    });
  });

  describe(`${EvmEventLogsReader.prototype.getLogsByTopic.name} (rpc)`, () => {
    let reader: EvmEventLogsReader;

    beforeEach(async () => {
      await deployTestErc20();

      reader = EvmEventLogsReader.fromConfig(
        {
          chain: TestChainName.test1,
          useRPC: true,
          paginationBlockRange: 1000,
        },
        multiProvider,
      );
    });

    it('should retrieve logs for Transfer events emitted by the contract', async () => {
      // Emit some Transfer events
      const tx1 = await testContract.transfer(
        tokenRecipient1.address,
        ethers.utils.parseEther('100'),
      );
      await tx1.wait();

      const tx2 = await testContract.transfer(
        tokenRecipient2.address,
        ethers.utils.parseEther('200'),
      );
      await tx2.wait();

      const logs = await reader.getLogsByTopic({
        eventTopic: transferTopic,
        contractAddress: testContract.address,
        fromBlock: deploymentBlockNumber,
      });

      // Should have 3 transfer events: 1 from constructor mint + 2 from transfers
      expect(logs).to.have.length(3);
      logs.forEach((log) => {
        expect(log.address).to.equal(testContract.address);
        expect(log.topics[0]).to.equal(transferTopic);
      });
    });

    it('should work when fromBlock is not specified (uses deployment block)', async () => {
      // Emit Transfer event
      const tx = await testContract.transfer(
        tokenRecipient1.address,
        ethers.utils.parseEther('100'),
      );
      await tx.wait();

      const logs = await reader.getLogsByTopic({
        eventTopic: transferTopic,
        contractAddress: testContract.address,
      });

      // Should have 2 transfer events: 1 from constructor mint + 1 from transfer
      expect(logs).to.have.length(2);
      logs.forEach((log) => {
        expect(log.address).to.equal(testContract.address);
        expect(log.topics[0]).to.equal(transferTopic);
      });
    });

    it('should work when toBlock is not specified (uses current block)', async () => {
      // Emit Transfer event
      const tx = await testContract.transfer(
        tokenRecipient1.address,
        ethers.utils.parseEther('100'),
      );
      await tx.wait();

      const logs = await reader.getLogsByTopic({
        eventTopic: transferTopic,
        contractAddress: testContract.address,
        fromBlock: deploymentBlockNumber,
        // No toBlock specified
      });

      // Should have 2 transfer events: 1 from constructor mint + 1 from transfer
      expect(logs).to.have.length(2);
      logs.forEach((log) => {
        expect(log.address).to.equal(testContract.address);
        expect(log.topics[0]).to.equal(transferTopic);
      });
    });

    it('should work when both fromBlock and toBlock are specified', async () => {
      await mineRandomNumberOfBlocks();
      const startBlock = await providerChainTest1.getBlockNumber();

      // Emit event in first block
      const tx1 = await testContract.transfer(
        tokenRecipient1.address,
        ethers.utils.parseEther('100'),
      );
      await tx1.wait();
      const firstEventBlock = await providerChainTest1.getBlockNumber();

      await mineRandomNumberOfBlocks();

      // Emit event in later block
      const tx2 = await testContract.transfer(
        tokenRecipient1.address,
        ethers.utils.parseEther('200'),
      );
      await tx2.wait();

      // Query only the first event's block range
      const logs = await reader.getLogsByTopic({
        eventTopic: transferTopic,
        contractAddress: testContract.address,
        fromBlock: startBlock,
        toBlock: firstEventBlock,
      });

      expect(logs).to.have.length(1);
      expect(logs[0].blockNumber).to.equal(firstEventBlock);
      expect(logs[0].address).to.equal(testContract.address);
      expect(logs[0].topics[0]).to.equal(transferTopic);
    });

    it('should return empty array when no logs match the filter', async () => {
      // Emit an event just to be sure that filtering works as expected
      const tx = await testContract.transfer(
        tokenRecipient1.address,
        ethers.utils.parseEther('100'),
      );
      await tx.wait();

      const nonExistentTopic = ethers.utils.id('NonExistentEvent(uint256)');
      const logs = await reader.getLogsByTopic({
        eventTopic: nonExistentTopic,
        contractAddress: testContract.address,
        fromBlock: deploymentBlockNumber,
      });

      expect(logs).to.have.length(0);
    });

    it('should handle multiple events across different blocks', async () => {
      const numberOfEventsToEmit = randomInt(3, 10);
      const eventBlocks: number[] = [];

      for (let i = 0; i < numberOfEventsToEmit; i++) {
        const tx = await testContract.mint(
          ethers.utils.parseEther(`${(i + 1) * 50}`),
        );
        await tx.wait();
        eventBlocks.push(await providerChainTest1.getBlockNumber());

        // Mine a few blocks between events
        await mineRandomNumberOfBlocks();
      }

      // +1 because of the transfer event emitted on contract deployment
      const expectedNumberOfEvents = numberOfEventsToEmit + 1;
      const logs = await reader.getLogsByTopic({
        eventTopic: transferTopic,
        contractAddress: testContract.address,
        fromBlock: deploymentBlockNumber,
      });

      expect(logs).to.have.length(expectedNumberOfEvents);

      // Verify all logs are from the correct contract and have the right topic
      logs.forEach((log) => {
        expect(log.address).to.equal(testContract.address);
        expect(log.topics[0]).to.equal(transferTopic);
      });
    });

    it('should work with small logPageSize (testing chunking)', async () => {
      const readerWithSmallPageSize = EvmEventLogsReader.fromConfig(
        {
          chain: TestChainName.test1,
          useRPC: true,
          paginationBlockRange: 2,
        },
        multiProvider,
      );

      const numberOfEventsToEmit = 5;
      for (let i = 0; i < numberOfEventsToEmit; i++) {
        const tx = await testContract.mint(
          ethers.utils.parseEther(`${(i + 1) * 100}`),
        );
        await tx.wait();
      }

      // +1 because of the transfer event emitted on contract deployment
      const expectedNumberOfEvents = numberOfEventsToEmit + 1;
      const logs = await readerWithSmallPageSize.getLogsByTopic({
        eventTopic: transferTopic,
        contractAddress: testContract.address,
        fromBlock: deploymentBlockNumber,
      });

      expect(logs).to.have.length(expectedNumberOfEvents);
    });

    it('should throw an error for non-existing contract address', async () => {
      const nonExistentAddress = randomAddress();

      await expect(
        reader.getLogsByTopic({
          eventTopic: transferTopic,
          contractAddress: nonExistentAddress,
          fromBlock: deploymentBlockNumber,
        }),
      ).to.be.rejected;
    });

    it('should handle edge case where fromBlock equals toBlock', async () => {
      // Emit event
      const tx = await testContract.transfer(
        tokenRecipient1.address,
        ethers.utils.parseEther('100'),
      );
      await tx.wait();
      const eventBlock = await providerChainTest1.getBlockNumber();

      const logs = await reader.getLogsByTopic({
        eventTopic: transferTopic,
        contractAddress: testContract.address,
        fromBlock: eventBlock,
        toBlock: eventBlock,
      });

      expect(logs).to.have.length(1);
      expect(logs[0].blockNumber).to.equal(eventBlock);
    });
  });

  describe(`${EvmEventLogsReader.prototype.getLogsByTopic.name} (block explorer)`, () => {
    let reader: EvmEventLogsReader;
    let multiProvider: MultiProvider;

    beforeEach(async () => {
      await deployTestErc20();

      multiProvider = new MultiProvider({
        ethereum: ethereumTestChain,
      });
      reader = EvmEventLogsReader.fromConfig(
        {
          chain: ethereumTestChain.name,
        },
        multiProvider,
      );
    });

    it('should get the expected number of events when fromBlock is not provided', async () => {
      const res = await reader.getLogsByTopic({
        contractAddress: KNOWN_ETHEREUM_TIMELOCK_CONTRACT,
        // CallExecuted signature
        eventTopic:
          '0xc2617efa69bab66782fa219543714338489c4e9e178271560a91b82c3f612b58',
        // Omitting from block to test getting contract deployment block from explorer
        toBlock: 15_000_000,
      });

      expect(res.length).to.equal(17);
    });
  });

  describe('retry before fallback', () => {
    it('should keep the explorer deployment block when logs fall back to RPC', async () => {
      await deployTestErc20();

      const reader = EvmEventLogsReader.fromConfig(
        { chain: TestChainName.test1 },
        multiProvider,
      );
      const primaryStrategy = reader['logReaderStrategy'];
      const fallbackStrategy = reader['fallbackLogReaderStrategy'];
      assert(
        primaryStrategy instanceof FallbackEvmEventLogsReader,
        'Expected a fallback explorer log reader',
      );
      assert(fallbackStrategy, 'Expected an RPC fallback log reader');
      const [explorerReader] = primaryStrategy['readers'];
      sinon
        .stub(explorerReader, 'getContractDeploymentBlockNumber')
        .resolves(deploymentBlockNumber);
      const explorerGetLogs = sinon
        .stub(explorerReader, 'getContractLogs')
        .rejects(
          Object.assign(new Error('explorer logs unavailable'), {
            isRecoverable: false,
          }),
        );
      const fallbackGetLogs = sinon.spy(fallbackStrategy, 'getContractLogs');

      const fromBlock = await reader.getContractDeploymentBlockFromExplorer(
        testContract.address,
      );
      const logs = await reader.getLogsByTopic({
        eventTopic: transferTopic,
        contractAddress: testContract.address,
        fromBlock,
      });

      expect(logs).to.have.length(1);
      expect(explorerGetLogs.calledOnce).to.be.true;
      expect(fallbackGetLogs.calledOnce).to.be.true;
      expect(fallbackGetLogs.firstCall.args[0].fromBlock).to.equal(
        deploymentBlockNumber,
      );
    });

    it('should succeed on retry without hitting fallback', async () => {
      await deployTestErc20();

      const reader = EvmEventLogsReader.fromConfig(
        { chain: TestChainName.test1, useRPC: true },
        multiProvider,
      );

      // Manually add a fallback so we can verify it's not called
      const fallback = new EvmRpcEventLogsReader(
        TestChainName.test1,
        {},
        multiProvider,
      );
      reader['fallbackLogReaderStrategy'] = fallback;
      const fallbackSpy = sinon.spy(fallback, 'getContractLogs');

      // Make primary strategy fail once then succeed
      const primaryStrategy = reader['logReaderStrategy'];
      const originalGetLogs =
        primaryStrategy.getContractLogs.bind(primaryStrategy);
      let callCount = 0;
      primaryStrategy.getContractLogs = async (opts: any) => {
        if (callCount++ === 0) throw new Error('rate limit');
        return originalGetLogs(opts);
      };

      const logs = await reader.getLogsByTopic({
        eventTopic: transferTopic,
        contractAddress: testContract.address,
        fromBlock: deploymentBlockNumber,
      });

      // Primary succeeded on retry, fallback never called
      expect(logs.length).to.be.greaterThan(0);
      expect(callCount).to.equal(2);
      expect(fallbackSpy.callCount).to.equal(0);
    });

    it('should fall back after all retries exhausted', async () => {
      await deployTestErc20();

      const reader = EvmEventLogsReader.fromConfig(
        { chain: TestChainName.test1, useRPC: true },
        multiProvider,
      );

      // Make primary strategy always fail
      reader['logReaderStrategy'] = {
        getContractDeploymentBlockNumber: async () => deploymentBlockNumber,
        getContractLogs: async () => {
          throw new Error('permanent failure');
        },
      };

      // Set fallback to a working RPC reader
      const fallback = new EvmRpcEventLogsReader(
        TestChainName.test1,
        {},
        multiProvider,
      );
      reader['fallbackLogReaderStrategy'] = fallback;
      const fallbackSpy = sinon.spy(fallback, 'getContractLogs');

      const logs = await reader.getLogsByTopic({
        eventTopic: transferTopic,
        contractAddress: testContract.address,
        fromBlock: deploymentBlockNumber,
      });

      expect(logs.length).to.be.greaterThan(0);
      expect(fallbackSpy.callCount).to.equal(1);
    });

    it('should use the same toBlock for primary and fallback reads', async () => {
      await deployTestErc20();

      const reader = EvmEventLogsReader.fromConfig(
        { chain: TestChainName.test1, useRPC: true },
        multiProvider,
      );
      const snapshotBlock = deploymentBlockNumber + 100;
      const getBlockNumber = sinon
        .stub(providerChainTest1, 'getBlockNumber')
        .onFirstCall()
        .resolves(snapshotBlock)
        .onSecondCall()
        .resolves(snapshotBlock + 1);
      const primaryGetLogs = sinon.stub().rejects(
        Object.assign(new Error('primary failed'), {
          isRecoverable: false,
        }),
      );
      const fallbackGetLogs = sinon.stub().resolves([]);

      reader['logReaderStrategy'] = {
        getContractDeploymentBlockNumber: async () => deploymentBlockNumber,
        getContractLogs: primaryGetLogs,
      };
      reader['fallbackLogReaderStrategy'] = {
        getContractDeploymentBlockNumber: async () => deploymentBlockNumber,
        getContractLogs: fallbackGetLogs,
      };

      await reader.getLogsByTopic({
        eventTopic: transferTopic,
        contractAddress: testContract.address,
        fromBlock: deploymentBlockNumber,
      });

      expect(getBlockNumber.callCount).to.equal(1);
      expect(primaryGetLogs.firstCall.args[0].toBlock).to.equal(snapshotBlock);
      expect(fallbackGetLogs.firstCall.args[0].toBlock).to.equal(snapshotBlock);
    });
  });

  describe('deployment block cache', () => {
    it('falls back between explorers for deployment blocks and logs', async () => {
      await deployTestErc20();

      const multiExplorerProvider = new MultiProvider({
        [TestChainName.test1]: {
          ...test1,
          blockExplorers: [
            {
              apiKey: 'first-key',
              apiUrl: 'https://first.example.com/api',
              family: ExplorerFamily.Etherscan,
              name: 'First explorer',
              url: 'https://first.example.com',
            },
            {
              apiUrl: 'https://second.example.com/api',
              family: ExplorerFamily.Blockscout,
              name: 'Second explorer',
              url: 'https://second.example.com',
            },
          ],
        },
      });
      multiExplorerProvider.setProvider(
        TestChainName.test1,
        providerChainTest1,
      );
      const reader = EvmEventLogsReader.fromConfig(
        { chain: TestChainName.test1 },
        multiExplorerProvider,
      );
      const fallbackExplorerReader = reader['logReaderStrategy'];
      assert(
        fallbackExplorerReader instanceof FallbackEvmEventLogsReader,
        'Expected a fallback explorer log reader',
      );
      const [firstExplorer, secondExplorer] = fallbackExplorerReader['readers'];
      const firstError = Object.assign(new Error('first explorer failed'), {
        isRecoverable: false,
      });
      const firstLookup = sinon
        .stub(firstExplorer, 'getContractDeploymentBlockNumber')
        .rejects(firstError);
      const secondLookup = sinon
        .stub(secondExplorer, 'getContractDeploymentBlockNumber')
        .resolves(deploymentBlockNumber);
      const firstGetLogs = sinon
        .stub(firstExplorer, 'getContractLogs')
        .rejects(firstError);
      const secondGetLogs = sinon
        .stub(secondExplorer, 'getContractLogs')
        .resolves([]);
      const rpcReader = reader['fallbackLogReaderStrategy'];
      assert(rpcReader, 'Expected an RPC fallback log reader');
      const rpcGetLogs = sinon.stub(rpcReader, 'getContractLogs').resolves([]);

      expect(
        await reader.getContractDeploymentBlockFromExplorer(
          testContract.address,
        ),
      ).to.equal(deploymentBlockNumber);
      expect(firstLookup.calledOnce).to.be.true;
      expect(secondLookup.calledOnce).to.be.true;

      expect(
        await reader.getLogsByTopic({
          contractAddress: testContract.address,
          eventTopic: transferTopic,
          fromBlock: deploymentBlockNumber,
          toBlock: deploymentBlockNumber,
        }),
      ).to.deep.equal([]);
      expect(firstGetLogs.calledOnce).to.be.true;
      expect(secondGetLogs.calledOnce).to.be.true;
      expect(rpcGetLogs.notCalled).to.be.true;
    });

    it('should reject an explorer deployment lookup for an RPC-only reader', async () => {
      await deployTestErc20();

      const reader = EvmEventLogsReader.fromConfig(
        { chain: TestChainName.test1, useRPC: true },
        multiProvider,
      );
      const deploymentSpy = sinon.spy(
        reader['logReaderStrategy'],
        'getContractDeploymentBlockNumber',
      );

      await expect(
        reader.getContractDeploymentBlockFromExplorer(testContract.address),
      ).to.be.rejectedWith(
        `No block explorer is configured for chain ${TestChainName.test1}`,
      );
      expect(deploymentSpy.notCalled).to.be.true;
    });

    it('should not use a cached RPC deployment block as an explorer block', async () => {
      await deployTestErc20();

      const reader = EvmEventLogsReader.fromConfig(
        { chain: TestChainName.test1 },
        multiProvider,
      );
      const primaryStrategy = reader['logReaderStrategy'];
      assert(
        primaryStrategy instanceof FallbackEvmEventLogsReader,
        'Expected a fallback explorer log reader',
      );
      const [explorerReader] = primaryStrategy['readers'];
      reader['deploymentBlockCache'].set(
        testContract.address,
        deploymentBlockNumber + 1,
      );
      const deploymentStub = sinon
        .stub(explorerReader, 'getContractDeploymentBlockNumber')
        .resolves(deploymentBlockNumber);

      expect(
        await reader.getContractDeploymentBlockFromExplorer(
          testContract.address,
        ),
      ).to.equal(deploymentBlockNumber);
      expect(
        await reader.getContractDeploymentBlockFromExplorer(
          testContract.address,
        ),
      ).to.equal(deploymentBlockNumber);
      expect(deploymentStub.calledOnce).to.be.true;
      expect(reader['deploymentBlockCache'].get(testContract.address)).to.equal(
        deploymentBlockNumber,
      );
    });

    it('should only look up deployment block once for the same contract', async () => {
      await deployTestErc20();

      const reader = EvmEventLogsReader.fromConfig(
        { chain: TestChainName.test1, useRPC: true },
        multiProvider,
      );

      const primaryStrategy = reader['logReaderStrategy'];
      const deploymentSpy = sinon.spy(
        primaryStrategy,
        'getContractDeploymentBlockNumber',
      );

      // Two calls without fromBlock — both need the deployment block
      await reader.getLogsByTopic({
        eventTopic: transferTopic,
        contractAddress: testContract.address,
      });
      await reader.getLogsByTopic({
        eventTopic: ethers.utils.id('Approval(address,address,uint256)'),
        contractAddress: testContract.address,
      });

      expect(deploymentSpy.callCount).to.equal(1);
    });

    // The block an RPC strategy answers with when the endpoint cannot serve
    // the historical state its search needs, and the one value a cache read
    // testing the entry for truthiness misses.
    it('should only look up a deployment block of zero once', async () => {
      await deployTestErc20();

      const reader = EvmEventLogsReader.fromConfig(
        { chain: TestChainName.test1, useRPC: true },
        multiProvider,
      );

      const strategy = {
        getContractDeploymentBlockNumber: async () => 0,
        getContractLogs: async () => [],
      };
      const deploymentSpy = sinon.spy(
        strategy,
        'getContractDeploymentBlockNumber',
      );
      reader['logReaderStrategy'] = strategy;

      await reader.getLogsByTopic({
        eventTopic: transferTopic,
        contractAddress: testContract.address,
      });
      await reader.getLogsByTopic({
        eventTopic: transferTopic,
        contractAddress: testContract.address,
      });

      expect(deploymentSpy.callCount).to.equal(1);
    });

    it('should not look up deployment block when fromBlock is provided', async () => {
      await deployTestErc20();

      const reader = EvmEventLogsReader.fromConfig(
        { chain: TestChainName.test1, useRPC: true },
        multiProvider,
      );

      const primaryStrategy = reader['logReaderStrategy'];
      const deploymentSpy = sinon.spy(
        primaryStrategy,
        'getContractDeploymentBlockNumber',
      );

      await reader.getLogsByTopic({
        eventTopic: transferTopic,
        contractAddress: testContract.address,
        fromBlock: deploymentBlockNumber,
      });

      expect(deploymentSpy.callCount).to.equal(0);
    });
  });

  describe('error handling', () => {
    let reader: EvmEventLogsReader;

    beforeEach(async () => {
      await deployTestErc20();

      reader = EvmEventLogsReader.fromConfig(
        {
          chain: TestChainName.test1,
          useRPC: true,
        },
        multiProvider,
      );
    });

    it('should not allow invalid topic signatures', async () => {
      const invalidTopic = 'invalid-topic';

      expect(
        reader.getLogsByTopic({
          eventTopic: invalidTopic,
          contractAddress: testContract.address,
          fromBlock: deploymentBlockNumber,
        }),
      ).to.be.rejectedWith();
    });

    it('should reject a log outside the requested range', async () => {
      const toBlock = deploymentBlockNumber + 10;
      const outOfRangeLog: GetEventLogsResponse = {
        address: testContract.address,
        blockNumber: toBlock + 1,
        data: '0x',
        logIndex: 0,
        topics: [transferTopic],
        transactionHash: ethers.constants.HashZero,
        transactionIndex: 0,
      };
      reader['logReaderStrategy'] = {
        getContractDeploymentBlockNumber: async () => deploymentBlockNumber,
        getContractLogs: async () => [outOfRangeLog],
      };

      await expect(
        reader.getLogsByTopic({
          eventTopic: transferTopic,
          contractAddress: testContract.address,
          fromBlock: deploymentBlockNumber,
          toBlock,
        }),
      ).to.be.rejectedWith(
        `Log block ${toBlock + 1} is outside requested range ${deploymentBlockNumber}-${toBlock}`,
      );
    });

    it('should reject a deployment block above the snapshotted head', async () => {
      const headBlock = deploymentBlockNumber;
      const deploymentBlock = headBlock + 1;
      sinon.stub(providerChainTest1, 'getBlockNumber').resolves(headBlock);
      const getContractLogs = sinon.stub().resolves([]);
      reader['logReaderStrategy'] = {
        getContractDeploymentBlockNumber: async () => deploymentBlock,
        getContractLogs,
      };

      await expect(
        reader.getLogsByTopic({
          eventTopic: transferTopic,
          contractAddress: testContract.address,
        }),
      ).to.be.rejectedWith(
        `Log range start ${deploymentBlock} exceeds end ${headBlock}`,
      );
      expect(getContractLogs.notCalled).to.be.true;
    });
  });
});
