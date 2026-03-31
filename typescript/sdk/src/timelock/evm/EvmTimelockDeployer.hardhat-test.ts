import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import hre from 'hardhat';

import { TimelockController__factory } from '@hyperlane-xyz/core';
import { assert } from '@hyperlane-xyz/utils';

import { TestChainName } from '../../consts/testChains.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { randomAddress } from '../../test/testUtils.js';
import { TimelockConfig } from '../types.js';

import { EvmTimelockDeployer } from './EvmTimelockDeployer.js';
import {
  CANCELLER_ROLE,
  EMPTY_BYTES_32,
  EXECUTOR_ROLE,
  PROPOSER_ROLE,
} from './constants.js';

chai.use(chaiAsPromised);

describe('EvmTimelockDeployer', async () => {
  let multiProvider: MultiProvider;
  let deployer: EvmTimelockDeployer;
  let signer: SignerWithAddress;
  const signerAddress = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
  const otherSignerAddress = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
  let otherSigner: SignerWithAddress;

  type TestCase = {
    title: string;
    config: TimelockConfig;
  };

  beforeEach(async () => {
    [signer, otherSigner] = await hre.ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });
    deployer = new EvmTimelockDeployer(multiProvider);

    assert(
      signer.address === signerAddress,
      'Expected signer.address to be equal signerAddress',
    );
    assert(
      otherSigner.address === otherSignerAddress,
      'Expected otherSigner.address address to be equal otherSignerAddress',
    );
  });

  describe('basic config', async () => {
    const testCases: TestCase[] = [
      {
        title: 'should deploy TimelockController with correct parameters',
        config: {
          minimumDelay: 3600,
          proposers: [signerAddress],
          executors: [signerAddress],
          admin: signerAddress,
        },
      },
      {
        title:
          'should deploy TimelockController with multiple proposers and executors',
        config: {
          minimumDelay: 7200,
          proposers: [signerAddress, randomAddress()],
          executors: [signerAddress, randomAddress()],
          admin: signerAddress,
        },
      },
      {
        title: 'should deploy with minimum delay of 0',
        config: {
          minimumDelay: 0,
          proposers: [signerAddress],
          executors: [signerAddress],
          admin: signerAddress,
        },
      },
    ];

    for (const { title, config } of testCases) {
      it(title, async () => {
        const { TimelockController } = await deployer.deployContracts(
          TestChainName.test2,
          config,
        );
        const timelockAddress = TimelockController.address;

        const timelock = TimelockController__factory.connect(
          timelockAddress as string,
          multiProvider.getProvider(TestChainName.test2),
        );

        expect(await timelock.getMinDelay()).to.equal(config.minimumDelay);

        for (const proposer of config.proposers) {
          expect(await timelock.hasRole(PROPOSER_ROLE, proposer)).to.be.true;
        }

        // proposers are also cancellers by default
        for (const proposer of config.proposers) {
          expect(await timelock.hasRole(CANCELLER_ROLE, proposer)).to.be.true;
        }

        assert(config.executors, 'Expected executors to be defined');
        for (const executor of config.executors) {
          expect(await timelock.hasRole(EXECUTOR_ROLE, executor)).to.be.true;
        }
      });
    }
  });

  describe('multichain deployments', () => {
    const config: TimelockConfig = {
      minimumDelay: 3600,
      proposers: [signerAddress],
      executors: [signerAddress],
      admin: signerAddress,
    };

    it('should not redeploy if contract already exists', async () => {
      const chainName = TestChainName.test1;

      // Deploy first time
      await deployer.deployContracts(chainName, config);
      const firstAddress = deployer.deployedContracts[chainName];

      // Deploy again with same config
      await deployer.deployContracts(chainName, config);
      const secondAddress = deployer.deployedContracts[chainName];

      expect(firstAddress).to.equal(secondAddress);
    });

    it('should deploy different contracts for different chains', async () => {
      const {
        TimelockController: { address: address1 },
      } = await deployer.deployContracts(TestChainName.test1, config);
      const {
        TimelockController: { address: address2 },
      } = await deployer.deployContracts(TestChainName.test2, config);

      expect(address1).to.not.equal(address2);
      expect(address1).to.exist;
      expect(address2).to.exist;
    });
  });

  it('should allow anyone to execute a transaction if no one is set in the input config', async () => {
    const openExecutorRoleConfig: TimelockConfig = {
      minimumDelay: 0,
      proposers: [signerAddress],
      admin: signerAddress,
    };

    const { TimelockController } = await deployer.deployContracts(
      TestChainName.test4,
      openExecutorRoleConfig,
    );
    const timelockAddress = TimelockController.address;
    const timelock = TimelockController__factory.connect(
      timelockAddress,
      signer,
    );

    // If the 0 address has the executor role anyone can execute
    expect(
      await timelock.hasRole(EXECUTOR_ROLE, hre.ethers.constants.AddressZero),
    ).to.be.true;

    // Test that someone who does not have the executor role can execute proposed transactions
    expect(await timelock.hasRole(EXECUTOR_ROLE, otherSignerAddress)).to.be
      .false;

    const updatedDelay = 100;
    const testTxData =
      TimelockController__factory.createInterface().encodeFunctionData(
        'updateDelay',
        [updatedDelay],
      );

    const scheduleTx = await timelock.schedule(
      timelockAddress,
      0,
      testTxData,
      EMPTY_BYTES_32,
      EMPTY_BYTES_32,
      0,
    );
    await scheduleTx.wait();

    const otherSignerTimelockInstance = TimelockController__factory.connect(
      timelockAddress,
      otherSigner,
    );
    const executeTx = await otherSignerTimelockInstance.execute(
      timelockAddress,
      0,
      testTxData,
      EMPTY_BYTES_32,
      EMPTY_BYTES_32,
    );
    await executeTx.wait();

    expect(await timelock.getMinDelay()).to.equal(updatedDelay);
  });

  describe('canceller config', () => {
    it('should deploy with the correct canceller config', async () => {
      const proposer = randomAddress();
      const cancellerConfig: TimelockConfig = {
        minimumDelay: 30,
        proposers: [proposer],
        executors: [signerAddress],
        cancellers: [randomAddress(), randomAddress()],
      };

      const { TimelockController } = await deployer.deployContracts(
        TestChainName.test4,
        cancellerConfig,
      );

      // proposer should be a proposer but not a canceller if not in canceller config
      assert(cancellerConfig.proposers, 'Expected proposers to be defined');
      for (const proposer of cancellerConfig.proposers) {
        expect(await TimelockController.hasRole(PROPOSER_ROLE, proposer)).to.be
          .true;
        expect(await TimelockController.hasRole(CANCELLER_ROLE, proposer)).to.be
          .false;
      }

      assert(cancellerConfig.cancellers, 'Expected cancellers to be defined');
      for (const canceller of cancellerConfig.cancellers) {
        expect(await TimelockController.hasRole(CANCELLER_ROLE, canceller)).to
          .be.true;
      }
    });

    it('should not remove a proposer that it is also a canceller', async () => {
      const proposer = randomAddress();
      const cancellerConfig: TimelockConfig = {
        minimumDelay: 30,
        proposers: [proposer],
        executors: [signerAddress],
        cancellers: [proposer, randomAddress()],
      };

      const { TimelockController } = await deployer.deployContracts(
        TestChainName.test4,
        cancellerConfig,
      );

      expect(await TimelockController.hasRole(PROPOSER_ROLE, proposer)).to.be
        .true;
      assert(cancellerConfig.cancellers, 'Expected cancellers to be defined');
      for (const canceller of cancellerConfig.cancellers) {
        expect(await TimelockController.hasRole(CANCELLER_ROLE, canceller)).to
          .be.true;
      }
    });
  });

  describe('admin config', () => {
    const proposer = randomAddress();
    const customAdmin = randomAddress();
    const testCases: TestCase[] = [
      {
        title:
          'should deploy TimelockController with the timelock as the only admin when an admin address is not provided',
        config: {
          minimumDelay: 1800,
          proposers: [signerAddress],
          executors: [signerAddress],
        },
      },
      {
        title:
          'should not revoke the admin role from the deployer if it is the expected admin',
        config: {
          minimumDelay: 30,
          proposers: [randomAddress()],
          executors: [signerAddress],
          cancellers: [randomAddress()],
          admin: signerAddress,
        },
      },
      {
        title:
          'should set the expected admin from the config after applying the changes',
        config: {
          minimumDelay: 30,
          proposers: [proposer],
          executors: [signerAddress],
          cancellers: [proposer, randomAddress()],
          admin: customAdmin,
        },
      },
    ];

    for (const { title, config } of testCases) {
      it(title, async () => {
        const { TimelockController } = await deployer.deployContracts(
          TestChainName.test3,
          config,
        );

        const timelockAdminRoleHash =
          await TimelockController.TIMELOCK_ADMIN_ROLE();

        // if an admin was set in the config we expect the timelock to be the admin
        const expectedAdmin = config.admin ?? TimelockController.address;
        expect(
          await TimelockController.hasRole(
            timelockAdminRoleHash,
            expectedAdmin,
          ),
        ).to.be.true;
      });
    }
  });
});
