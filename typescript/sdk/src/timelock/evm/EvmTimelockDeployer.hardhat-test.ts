import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { keccak256 } from 'ethers/lib/utils.js';
import hre from 'hardhat';

import { TimelockController__factory } from '@hyperlane-xyz/core';

import { TestChainName } from '../../consts/testChains.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { randomAddress } from '../../test/testUtils.js';
import { TimelockConfig } from '../types.js';

import { EvmTimelockDeployer } from './EvmTimelockDeployer.js';

chai.use(chaiAsPromised);

describe('EvmTimelockDeployer', async () => {
  let multiProvider: MultiProvider;
  let deployer: EvmTimelockDeployer;
  let signer: SignerWithAddress;
  let config: TimelockConfig;
  const PROPOSER_ROLE: string = keccak256(Buffer.from('PROPOSER_ROLE'));
  const EXECUTOR_ROLE: string = keccak256(Buffer.from('EXECUTOR_ROLE'));
  const CANCELLER_ROLE: string = keccak256(Buffer.from('CANCELLER_ROLE'));

  before(async () => {
    [signer] = await hre.ethers.getSigners();
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
});
