import { JsonRpcProvider } from '@ethersproject/providers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import hre from 'hardhat';

import {
  TimelockController,
  TimelockController__factory,
} from '@hyperlane-xyz/core';
import { assert, randomInt } from '@hyperlane-xyz/utils';

import { TestChainName } from '../../consts/testChains.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { randomAddress } from '../../test/testUtils.js';
import { TimelockConfig } from '../types.js';

import { EvmTimelockDeployer } from './EvmTimelockDeployer.js';
import { CANCELLER_ROLE, EXECUTOR_ROLE, PROPOSER_ROLE } from './constants.js';

chai.use(chaiAsPromised);

describe('EvmTimelockDeployer', async () => {
  let multiProvider: MultiProvider;
  let deployer: EvmTimelockDeployer;
  let signer: SignerWithAddress;
  let otherSigner: SignerWithAddress;
  let config: TimelockConfig;

  beforeEach(async () => {
    [signer, otherSigner] = await hre.ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });
    deployer = new EvmTimelockDeployer(multiProvider);
    config = {
      minimumDelay: 3600,
      proposers: [signer.address],
      executors: [signer.address],
      admin: signer.address,
    };
  });

  it('should deploy TimelockController with correct parameters', async () => {
    await deployer.deploy({ [TestChainName.test1]: config });
    const { TimelockController } =
      deployer.deployedContracts[TestChainName.test1];
    const timelockAddress = TimelockController.address;
    const timelockAdminRoleHash =
      await TimelockController.TIMELOCK_ADMIN_ROLE();

    expect(timelockAddress).to.exist;

    const timelock = TimelockController__factory.connect(
      timelockAddress,
      multiProvider.getProvider(TestChainName.test1),
    );

    expect(await timelock.getMinDelay()).to.equal(config.minimumDelay);
    expect(await timelock.hasRole(PROPOSER_ROLE, config.proposers[0])).to.be
      .true;
    assert(config.executors, 'Expected executors to be defined');
    expect(await timelock.hasRole(EXECUTOR_ROLE, config.executors[0])).to.be
      .true;
    expect(await timelock.hasRole(timelockAdminRoleHash, config.admin!)).to.be
      .true;
  });

  it('should deploy TimelockController with multiple proposers and executors', async () => {
    const multiConfig: TimelockConfig = {
      minimumDelay: 7200, // 2 hours
      proposers: [signer.address, randomAddress()],
      executors: [signer.address, randomAddress()],
      admin: signer.address,
    };

    const { TimelockController } = await deployer.deployContracts(
      TestChainName.test2,
      multiConfig,
    );
    const timelockAddress = TimelockController.address;

    const timelock = TimelockController__factory.connect(
      timelockAddress as string,
      multiProvider.getProvider(TestChainName.test2),
    );

    expect(await timelock.getMinDelay()).to.equal(multiConfig.minimumDelay);

    for (const proposer of multiConfig.proposers) {
      expect(await timelock.hasRole(PROPOSER_ROLE, proposer)).to.be.true;
    }

    // proposers are also cancellers by default
    for (const proposer of multiConfig.proposers) {
      expect(await timelock.hasRole(CANCELLER_ROLE, proposer)).to.be.true;
    }

    assert(multiConfig.executors, 'Expected executors to be defined');
    for (const executor of multiConfig.executors) {
      expect(await timelock.hasRole(EXECUTOR_ROLE, executor)).to.be.true;
    }
  });

  it('should deploy TimelockController with the timelock as the only admin when an admin address is not provided', async () => {
    const noAdminConfig: TimelockConfig = {
      minimumDelay: 1800,
      proposers: [signer.address],
      executors: [signer.address],
    };

    const { TimelockController } = await deployer.deployContracts(
      TestChainName.test3,
      noAdminConfig,
    );
    const timelockAddress = TimelockController.address;
    const timelockAdminRoleHash =
      await TimelockController.TIMELOCK_ADMIN_ROLE();

    const timelock = TimelockController__factory.connect(
      timelockAddress,
      multiProvider.getProvider(TestChainName.test3),
    );

    expect(await timelock.hasRole(timelockAdminRoleHash, timelockAddress)).to.be
      .true;
  });

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

  it('should deploy with minimum delay of 0', async () => {
    const zeroDelayConfig: TimelockConfig = {
      minimumDelay: 0,
      proposers: [signer.address],
      executors: [signer.address],
      admin: signer.address,
    };

    const { TimelockController } = await deployer.deployContracts(
      TestChainName.test4,
      zeroDelayConfig,
    );
    const timelockAddress = TimelockController.address;

    const timelock = TimelockController__factory.connect(
      timelockAddress,
      multiProvider.getProvider(TestChainName.test4),
    );

    expect(await timelock.getMinDelay()).to.equal(0);
  });

  it('should set anyone as a executor if no one is set in the input config', async () => {
    const zeroDelayConfig: TimelockConfig = {
      minimumDelay: 0,
      proposers: [signer.address],
      admin: signer.address,
    };

    const { TimelockController } = await deployer.deployContracts(
      TestChainName.test4,
      zeroDelayConfig,
    );
    const timelockAddress = TimelockController.address;

    const timelock = TimelockController__factory.connect(
      timelockAddress,
      multiProvider.getProvider(TestChainName.test4),
    );

    const _0_BYTES_32 =
      '0x0000000000000000000000000000000000000000000000000000000000000000';
    const updatedDelay = 100;
    const testTxData =
      TimelockController__factory.createInterface().encodeFunctionData(
        'updateDelay',
        [updatedDelay],
      );

    const signerTimelock = TimelockController__factory.connect(
      timelockAddress,
      signer,
    );
    const tx = await signerTimelock.schedule(
      timelockAddress,
      0,
      testTxData,
      _0_BYTES_32,
      _0_BYTES_32,
      0,
    );
    await tx.wait();

    const randomSignerTimelockInstance = TimelockController__factory.connect(
      timelockAddress,
      otherSigner,
    );
    const executeTx = await randomSignerTimelockInstance.execute(
      timelockAddress,
      0,
      testTxData,
      _0_BYTES_32,
      _0_BYTES_32,
    );
    await executeTx.wait();

    expect(await timelock.getMinDelay()).to.equal(updatedDelay);
  });

  async function assertCancellerConfig(
    expectedConfig: TimelockConfig,
    timelockInstance: TimelockController,
  ) {
    // proposer should be a proposer but not a canceller if not in canceller config
    assert(expectedConfig.proposers, 'Expected proposers to be defined');
    for (const proposer of expectedConfig.proposers) {
      expect(await timelockInstance.hasRole(PROPOSER_ROLE, proposer)).to.be
        .true;

      if (!expectedConfig.cancellers?.includes(proposer)) {
        expect(await timelockInstance.hasRole(CANCELLER_ROLE, proposer)).to.be
          .false;
      }
    }

    // cancellers should be a canceller but not a proposer if not in the proposer config
    assert(expectedConfig.cancellers, 'Expected cancellers to be defined');
    for (const canceller of expectedConfig.cancellers) {
      expect(await timelockInstance.hasRole(CANCELLER_ROLE, canceller)).to.be
        .true;
      if (!expectedConfig.proposers?.includes(canceller)) {
        expect(await timelockInstance.hasRole(PROPOSER_ROLE, canceller)).to.be
          .false;
      }
    }

    // signer should not be the timelock admin after deployment
    const timelockAdminRoleHash = await timelockInstance.TIMELOCK_ADMIN_ROLE();
    expect(
      await timelockInstance.hasRole(timelockAdminRoleHash, signer.address),
    ).to.be.false;

    // Timelock should still be the admin of itself
    expect(
      await timelockInstance.hasRole(
        timelockAdminRoleHash,
        timelockInstance.address,
      ),
    ).to.be.true;

    // if an admin was set it should be the admin after the changes
    if (expectedConfig.admin) {
      expect(
        await timelockInstance.hasRole(
          timelockAdminRoleHash,
          expectedConfig.admin,
        ),
      ).to.be.true;
    }
  }

  it('should deploy with the correct canceller config', async () => {
    const proposer = randomAddress();
    const cancellerConfig: TimelockConfig = {
      minimumDelay: 30,
      proposers: [proposer],
      executors: [signer.address],
      cancellers: [randomAddress(), randomAddress()],
    };

    const { TimelockController } = await deployer.deployContracts(
      TestChainName.test4,
      cancellerConfig,
    );
    const timelockAddress = TimelockController.address;

    const timelock = TimelockController__factory.connect(
      timelockAddress,
      multiProvider.getProvider(TestChainName.test4),
    );

    await assertCancellerConfig(cancellerConfig, timelock);
  });

  it('should not remove a proposer that it is also a canceller', async () => {
    const proposer = randomAddress();
    const cancellerConfig: TimelockConfig = {
      minimumDelay: 30,
      proposers: [proposer],
      executors: [signer.address],
      cancellers: [proposer, randomAddress()],
    };

    const { TimelockController } = await deployer.deployContracts(
      TestChainName.test4,
      cancellerConfig,
    );
    const timelockAddress = TimelockController.address;

    const timelock = TimelockController__factory.connect(
      timelockAddress,
      multiProvider.getProvider(TestChainName.test4),
    );

    await assertCancellerConfig(cancellerConfig, timelock);
  });

  it('should set the expected admin from the config after applying the canceller changes', async () => {
    const proposer = randomAddress();
    const cancellerConfig: TimelockConfig = {
      minimumDelay: 30,
      proposers: [proposer],
      executors: [signer.address],
      cancellers: [proposer, randomAddress()],
      admin: randomAddress(),
    };

    const { TimelockController } = await deployer.deployContracts(
      TestChainName.test4,
      cancellerConfig,
    );
    const timelockAddress = TimelockController.address;

    const timelock = TimelockController__factory.connect(
      timelockAddress,
      multiProvider.getProvider(TestChainName.test4),
    );

    await assertCancellerConfig(cancellerConfig, timelock);
  });
});
