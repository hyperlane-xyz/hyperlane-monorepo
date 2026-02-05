/* eslint-disable import/no-nodejs-modules */
import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { StartedDockerComposeEnvironment } from 'testcontainers';

import { TEST_TRON_PRIVATE_KEY } from '../testing/constants.js';
import {
  TronTestChainMetadata,
  runTronNode,
  stopTronNode,
} from '../testing/node.js';
import { TestStorage } from '../typechain/contracts/test/TestStorage.js';
import { TestStorage__factory } from '../typechain/factories/contracts/test/TestStorage__factory.js';

import { TronContractFactory } from './TronContractFactory.js';
import { TronJsonRpcProvider } from './TronJsonRpcProvider.js';
import { TronWallet } from './TronWallet.js';

const TEST_CHAIN: TronTestChainMetadata = {
  name: 'tron-test',
  chainId: 728126428,
  domainId: 728126428,
  rpcPort: 18545,
  httpPort: 18090,
};

describe('TronWallet Integration Tests', function () {
  this.timeout(120_000); // 2 minutes for container startup

  let environment: StartedDockerComposeEnvironment;
  let provider: TronJsonRpcProvider;
  let wallet: TronWallet;

  before(async () => {
    environment = await runTronNode(TEST_CHAIN);

    const rpcUrl = `http://127.0.0.1:${TEST_CHAIN.rpcPort}`;
    const httpUrl = `http://127.0.0.1:${TEST_CHAIN.httpPort}`;

    provider = new TronJsonRpcProvider(rpcUrl);
    wallet = new TronWallet(TEST_TRON_PRIVATE_KEY, provider, httpUrl);
  });

  after(async () => {
    if (environment) {
      await stopTronNode(environment);
    }
  });

  describe('TRX Transfer', () => {
    it('should transfer TRX to another address', async () => {
      // Generate a random recipient address
      const recipientPrivateKey =
        '0x1111111111111111111111111111111111111111111111111111111111111111';
      const recipientWallet = new TronWallet(
        recipientPrivateKey,
        provider,
        `http://127.0.0.1:${TEST_CHAIN.httpPort}`,
      );
      const recipientAddress = recipientWallet.address;

      // Get initial balances
      const senderBalanceBefore = await provider.getBalance(wallet.address);
      const recipientBalanceBefore =
        await provider.getBalance(recipientAddress);

      // Transfer 1 TRX (1,000,000 SUN)
      const transferAmount = BigNumber.from(1_000_000);
      const tx = await wallet.sendTransaction({
        to: recipientAddress,
        value: transferAmount,
      });

      // Wait for confirmation
      const receipt = await tx.wait();
      expect(receipt.status).to.equal(1);

      // Verify balances changed
      const senderBalanceAfter = await provider.getBalance(wallet.address);
      const recipientBalanceAfter = await provider.getBalance(recipientAddress);

      expect(recipientBalanceAfter.sub(recipientBalanceBefore)).to.deep.equal(
        transferAmount,
      );
      expect(senderBalanceBefore.gt(senderBalanceAfter)).to.be.true;
    });
  });

  describe('TronContractFactory', () => {
    let contract: TestStorage;

    const INITIAL_VALUE = 100;

    it('should deploy a contract with constructor args', async () => {
      const factory = new TronContractFactory<
        TestStorage__factory,
        TestStorage
      >(TestStorage__factory, wallet);
      contract = await factory.deploy(INITIAL_VALUE, wallet.address);

      expect(contract.address).to.be.a('string');
      expect(contract.address).to.match(/^0x[a-fA-F0-9]{40}$/);
    });

    it('should have correct initial value from constructor', async () => {
      const value = await contract.get();
      expect(value.toNumber()).to.equal(INITIAL_VALUE);
    });

    it('should have correct owner from constructor', async () => {
      const owner = await contract.owner();
      expect(owner.toLowerCase()).to.equal(wallet.address.toLowerCase());
    });

    it('should set a value', async () => {
      const newValue = 42;
      const tx = await contract.set(newValue);
      const receipt = await tx.wait();

      expect(receipt.status).to.equal(1);
    });

    it('should get the updated value', async () => {
      const value = await contract.get();
      expect(value.toNumber()).to.equal(42);
    });

    it('should read value property directly', async () => {
      const value = await contract.value();
      expect(value.toNumber()).to.equal(42);
    });

    it('should update value and read again', async () => {
      const newValue = 123;
      const tx = await contract.set(newValue);
      await tx.wait();

      const value = await contract.get();
      expect(value.toNumber()).to.equal(newValue);
    });
  });
});
