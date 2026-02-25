import { expect } from 'chai';
import { BigNumber } from 'ethers';

import {
  TronNodeInfo,
  TronTestChainMetadata,
  runTronNode,
  stopTronNode,
} from '../testing/node.js';
import { TestStorage } from '../typechain/contracts/test/TestStorage.js';
import { TestStorage__factory } from '../typechain/factories/contracts/test/TestStorage__factory.js';

import { TronContractFactory } from './TronContractFactory.js';
import { TronWallet } from './TronWallet.js';

const TEST_CHAIN: TronTestChainMetadata = {
  name: 'tron-test',
  chainId: 3360022319,
  domainId: 3360022319,
  port: 19090,
};

describe('TronWallet Integration Tests', function () {
  this.timeout(120_000); // 2 minutes for container startup

  let node: TronNodeInfo;
  let wallet: TronWallet;

  before(async () => {
    node = await runTronNode(TEST_CHAIN);

    const tronUrl = `http://127.0.0.1:${TEST_CHAIN.port}`;
    wallet = new TronWallet(node.privateKeys[0], tronUrl);
  });

  after(async () => {
    if (node) {
      await stopTronNode(node);
    }
  });

  describe('TRX Transfer', () => {
    it('should transfer TRX to another address', async () => {
      // Generate a random recipient address
      const recipientPrivateKey =
        '0x1111111111111111111111111111111111111111111111111111111111111111';
      const recipientWallet = new TronWallet(
        recipientPrivateKey,
        `http://127.0.0.1:${TEST_CHAIN.port}`,
      );
      const recipientAddress = recipientWallet.address;

      // Get initial balances
      const senderBalanceBefore = await wallet.provider.getBalance(
        wallet.address,
      );
      const recipientBalanceBefore =
        await wallet.provider.getBalance(recipientAddress);

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
      const senderBalanceAfter = await wallet.provider.getBalance(
        wallet.address,
      );
      const recipientBalanceAfter =
        await wallet.provider.getBalance(recipientAddress);

      expect(recipientBalanceAfter.sub(recipientBalanceBefore)).to.deep.equal(
        transferAmount,
      );
      expect(senderBalanceBefore.gt(senderBalanceAfter)).to.be.true;
    });
  });

  describe('TronContractFactory', () => {
    let contract: TestStorage;

    const INITIAL_VALUE = 100;

    it('should get deploy transaction and estimate gas', async () => {
      const factory = new TronContractFactory(
        new TestStorage__factory(),
        wallet,
      );

      // Get deploy transaction (pure ethers, no network call)
      const deployTx = factory.getDeployTransaction(
        INITIAL_VALUE,
        wallet.address,
      );
      expect(deployTx.data).to.be.a('string');
      expect(deployTx.data).to.match(/^0x/);

      // Estimate gas via Tron JSON-RPC
      const estimatedGas = await wallet.estimateGas(deployTx);
      expect(estimatedGas.gt(0)).to.be.true;
    });

    it('should deploy with gas limit override (like handleDeploy)', async () => {
      const factory = new TronContractFactory(
        new TestStorage__factory(),
        wallet,
      );

      // Simulate handleDeploy flow: estimate then deploy with buffered gas limit
      const deployTx = factory.getDeployTransaction(
        INITIAL_VALUE,
        wallet.address,
      );
      const estimatedGas = await wallet.estimateGas(deployTx);
      const bufferedGasLimit = estimatedGas.mul(120).div(100); // 20% buffer

      const deployed = await factory.deploy(INITIAL_VALUE, wallet.address, {
        gasLimit: bufferedGasLimit,
      });

      expect(deployed.address).to.be.a('string');
      expect(deployed.address).to.match(/^0x[a-fA-F0-9]{40}$/);

      // Verify we can interact with the deployed contract
      const value = await deployed.get();
      expect(value.toNumber()).to.equal(INITIAL_VALUE);
    });

    it('should deploy a contract with constructor args', async () => {
      const factory = new TronContractFactory(
        new TestStorage__factory(),
        wallet,
      );
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
