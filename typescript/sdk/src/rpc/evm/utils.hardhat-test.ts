import { JsonRpcProvider } from '@ethersproject/providers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { ethers } from 'ethers';
import hre from 'hardhat';

import { ERC20Test, ERC20Test__factory } from '@hyperlane-xyz/core';
import { assert } from '@hyperlane-xyz/utils';

import { TestChainName } from '../../consts/testChains.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { randomAddress, randomInt } from '../../test/testUtils.js';

import { getContractCreationBlockFromRpc, getLogsFromRpc } from './utils.js';

chai.use(chaiAsPromised);

describe('RPC Utils', () => {
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

    assert(
      contractOwner.provider,
      'Expected provider to be defined on the signer',
    );

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
    const blocksToMine = randomInt(69, 420);
    for (let blockNum = 0; blockNum < blocksToMine; blockNum++) {
      await providerChainTest1.send('evm_mine', []);
    }
  }

  describe(getContractCreationBlockFromRpc.name, () => {
    it('should find the correct deployment block for a deployed contract', async () => {
      await mineRandomNumberOfBlocks();

      await deployTestErc20();

      await mineRandomNumberOfBlocks();

      const foundBlock = await getContractCreationBlockFromRpc(
        TestChainName.test1,
        testContract.address,
        multiProvider,
      );

      expect(foundBlock).to.equal(deploymentBlockNumber);
      const contractCode = await providerChainTest1.getCode(
        testContract.address,
      );
      expect(contractCode).not.to.equal('0x');
    });

    it('should throw an error for non-existing contract address', async () => {
      const nonExistentAddress = randomAddress();

      await expect(
        getContractCreationBlockFromRpc(
          TestChainName.test1,
          nonExistentAddress,
          multiProvider,
        ),
      ).to.be.rejectedWith(
        `Address "${nonExistentAddress}" on chain "${TestChainName.test1}" is not a contract`,
      );
    });
  });

  describe(getLogsFromRpc.name, () => {
    beforeEach(async () => {
      await deployTestErc20();
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

      const logs = await getLogsFromRpc({
        chain: TestChainName.test1,
        contractAddress: testContract.address,
        multiProvider,
        fromBlock: deploymentBlockNumber,
        topic: transferTopic,
      });

      // Should have 3 transfer events: 1 from constructor mint + 2 from transfers
      expect(logs).to.have.length(3);
      logs.forEach((log) => {
        expect(log.address).to.equal(testContract.address);
        expect(log.topics[0]).to.equal(transferTopic);
      });
    });

    it('should work when fromBlock and toBlock are provided', async () => {
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
      const logs = await getLogsFromRpc({
        chain: TestChainName.test1,
        contractAddress: testContract.address,
        multiProvider,
        fromBlock: startBlock,
        toBlock: firstEventBlock,
        topic: transferTopic,
      });

      expect(logs).to.have.length(1);
      expect(logs[0].blockNumber).to.equal(firstEventBlock);
    });

    it('should work when a custom range parameter is provided', async () => {
      const numberOfEventsToEmit = randomInt(1, 47);
      for (let i = 0; i < numberOfEventsToEmit; i++) {
        const tx = await testContract.mint(
          ethers.utils.parseEther(`${(i + 1) * 100}`),
        );
        await tx.wait();
      }

      // +1 because of the transfer event emitted on contract deployment
      const expectedNumberOfEvents = numberOfEventsToEmit + 1;
      const logs = await getLogsFromRpc({
        chain: TestChainName.test1,
        contractAddress: testContract.address,
        multiProvider,
        fromBlock: deploymentBlockNumber,
        topic: transferTopic,
        // Small range to test chunking
        range: 2,
      });

      expect(logs).to.have.length(expectedNumberOfEvents);
    });

    it('should return empty array when no logs match the criteria', async () => {
      // Emitting an event just to be sure that filtering works as expected
      const tx1 = await testContract.transfer(
        tokenRecipient1.address,
        ethers.utils.parseEther('100'),
      );
      await tx1.wait();

      const nonExistentTopic = ethers.utils.id('NonExistentEvent(uint256)');
      const logs = await getLogsFromRpc({
        chain: TestChainName.test1,
        contractAddress: testContract.address,
        multiProvider,
        fromBlock: deploymentBlockNumber,
        topic: nonExistentTopic,
      });

      expect(logs).to.have.length(0);
    });
  });
});
