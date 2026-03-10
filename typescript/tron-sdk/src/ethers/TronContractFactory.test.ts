import { expect } from 'chai';
import { ContractFactory } from 'ethers';

import { TestStorage__factory } from '@hyperlane-xyz/core/tron/typechain/factories/contracts/test/TestStorage__factory.js';

import { TronContractFactory } from './TronContractFactory.js';
import { TronWallet } from './TronWallet.js';

async function expectReject(
  promise: Promise<unknown>,
  message: string,
): Promise<void> {
  try {
    await promise;
    expect.fail(`Expected rejection containing: ${message}`);
  } catch (error) {
    expect(String(error)).to.contain(message);
  }
}

describe('TronContractFactory', () => {
  const privateKey =
    '0x1111111111111111111111111111111111111111111111111111111111111111';
  const tronUrl = 'http://127.0.0.1:19090';

  it('reattaches deployments to the Tron-derived address and preserves deploymentTransaction', async () => {
    const originalDeploy = ContractFactory.prototype.deploy;
    const deploymentTx = { hash: `0x${'a'.repeat(64)}` };

    ContractFactory.prototype.deploy = async function () {
      return {
        target: '0x0000000000000000000000000000000000000001',
        deploymentTransaction: () => deploymentTx,
      } as any;
    };

    try {
      const wallet = new TronWallet(privateKey, tronUrl);
      (wallet as any).getTronTransaction = (hash: string) => {
        expect(hash).to.equal(deploymentTx.hash);
        return {
          txID: 'b'.repeat(64),
          raw_data: {},
          raw_data_hex: '0x',
          contract_address: `41${'c'.repeat(40)}`,
        };
      };
      (wallet as any).toEvmAddress = (address: string) => {
        expect(address).to.equal(`41${'c'.repeat(40)}`);
        return '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC';
      };

      const factory = new TronContractFactory(
        new TestStorage__factory(),
        wallet,
      );
      const contract = await factory.deploy(1, wallet.address);

      expect(contract.target).to.equal(
        '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC',
      );
      expect(contract.deploymentTransaction?.()).to.equal(deploymentTx);
    } finally {
      ContractFactory.prototype.deploy = originalDeploy;
    }
  });

  it('throws when the deployment transaction is missing', async () => {
    const originalDeploy = ContractFactory.prototype.deploy;

    ContractFactory.prototype.deploy = async function () {
      return {
        target: '0x0000000000000000000000000000000000000001',
        deploymentTransaction: () => null,
      } as any;
    };

    try {
      const factory = new TronContractFactory(
        new TestStorage__factory(),
        new TronWallet(privateKey, tronUrl),
      );

      await expectReject(
        factory.deploy(1, '0x1111111111111111111111111111111111111111'),
        'Expected deployment transaction',
      );
    } finally {
      ContractFactory.prototype.deploy = originalDeploy;
    }
  });

  it('throws when the runner is missing', async () => {
    const originalDeploy = ContractFactory.prototype.deploy;

    ContractFactory.prototype.deploy = async function () {
      return {
        target: '0x0000000000000000000000000000000000000001',
        deploymentTransaction: () => ({ hash: `0x${'a'.repeat(64)}` }),
      } as any;
    };

    try {
      const factory = new TronContractFactory(new TestStorage__factory());

      await expectReject(
        factory.deploy(1, '0x1111111111111111111111111111111111111111'),
        'TronContractFactory runner is required',
      );
    } finally {
      ContractFactory.prototype.deploy = originalDeploy;
    }
  });

  it('throws when the stored tron transaction is not a deployment', async () => {
    const originalDeploy = ContractFactory.prototype.deploy;

    ContractFactory.prototype.deploy = async function () {
      return {
        target: '0x0000000000000000000000000000000000000001',
        deploymentTransaction: () => ({ hash: `0x${'a'.repeat(64)}` }),
      } as any;
    };

    try {
      const wallet = new TronWallet(privateKey, tronUrl);
      (wallet as any).getTronTransaction = () => ({
        txID: 'b'.repeat(64),
        raw_data: {},
        raw_data_hex: '0x',
      });

      const factory = new TronContractFactory(
        new TestStorage__factory(),
        wallet,
      );

      await expectReject(
        factory.deploy(1, wallet.address),
        'Expected CreateSmartContractTransaction for deployment',
      );
    } finally {
      ContractFactory.prototype.deploy = originalDeploy;
    }
  });

  it('connect returns a new factory bound to the provided runner', () => {
    const wallet = new TronWallet(privateKey, tronUrl);
    const factory = new TronContractFactory(new TestStorage__factory());

    const connected = factory.connect(wallet);

    expect(connected).to.be.instanceOf(TronContractFactory);
    expect((connected as any).runner).to.equal(wallet);
  });
});
