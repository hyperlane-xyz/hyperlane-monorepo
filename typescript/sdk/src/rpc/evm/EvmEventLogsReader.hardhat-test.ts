import { JsonRpcProvider } from '@ethersproject/providers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { ethers } from 'ethers';
import hre from 'hardhat';

import { ERC20Test, ERC20Test__factory } from '@hyperlane-xyz/core';
import { assert } from '@hyperlane-xyz/utils';

import {
  KNOWN_BASE_TIMELOCK_CONTRACT,
  TestChainName,
  baseTestChain,
} from '../../consts/testChains.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { randomAddress, randomInt } from '../../test/testUtils.js';

import {
  EvmEtherscanLikeEventLogsReader,
  EvmEventLogsReader,
  EvmRpcEventLogsReader,
} from './EvmEventLogsReader.js';

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
        EvmEtherscanLikeEventLogsReader,
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
        base: baseTestChain,
      });
      reader = EvmEventLogsReader.fromConfig(
        {
          chain: baseTestChain.name,
        },
        multiProvider,
      );
    });

    it('should get the expected number of events when fromBlock is not provided', async () => {
      const res = await reader.getLogsByTopic({
        contractAddress: KNOWN_BASE_TIMELOCK_CONTRACT,
        // CallExecuted signature
        eventTopic:
          '0xc2617efa69bab66782fa219543714338489c4e9e178271560a91b82c3f612b58',
        // Omitting from block to test getting contract deployment block from explorer
        toBlock: 32986242,
      });

      expect(res.length).to.equal(5);
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
  });
});
