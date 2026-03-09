import { expect } from 'chai';
import { ContractFactory } from 'ethers';

import { TestStorage__factory } from '@hyperlane-xyz/core/tron/typechain/factories/contracts/test/TestStorage__factory.js';

import { TronContractFactory } from './TronContractFactory.js';
import { TronWallet } from './TronWallet.js';

describe('TronContractFactory', () => {
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
      const wallet = new TronWallet(
        '0x1111111111111111111111111111111111111111111111111111111111111111',
        'http://127.0.0.1:19090',
      );
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
});
