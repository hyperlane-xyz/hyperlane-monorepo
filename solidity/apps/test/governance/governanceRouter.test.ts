import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { abacus, ethers } from 'hardhat';

import { InterchainGasPaymaster, Outbox } from '@abacus-network/core';
import { utils } from '@abacus-network/utils';

import { GovernanceRouter, TestSet, TestSet__factory } from '../../types';

import { GovernanceConfig, GovernanceDeploy } from './lib/GovernanceDeploy';
import { formatCall, increaseTimestampBy } from './lib/utils';

const recoveryTimelock = 60 * 60 * 24 * 7;
const localDomain = 1000;
const remoteDomain = 2000;
const testDomain = 3000;
const domains = [localDomain, remoteDomain];
const ONLY_OWNER_REVERT_MESSAGE = 'Ownable: caller is not the owner';

describe('GovernanceRouter', async () => {
  let governor: SignerWithAddress,
    recoveryManager: SignerWithAddress,
    router: GovernanceRouter,
    remote: GovernanceRouter,
    testSet: TestSet,
    governance: GovernanceDeploy;
  let outbox: Outbox;
  let interchainGasPaymaster: InterchainGasPaymaster;
  const testInterchainGasPayment = 123456789;

  before(async () => {
    [governor, recoveryManager] = await ethers.getSigners();

    const testSetFactory = new TestSet__factory(governor);
    testSet = await testSetFactory.deploy();
  });

  beforeEach(async () => {
    const config: GovernanceConfig = {
      signer: governor,
      timelock: recoveryTimelock,
      recoveryManager: recoveryManager.address,
      governor: {
        domain: localDomain,
        address: governor.address,
      },
    };
    await abacus.deploy(domains, governor);
    governance = new GovernanceDeploy(config);
    await governance.deploy(abacus);
    router = governance.router(localDomain);
    remote = governance.router(remoteDomain);
    outbox = abacus.outbox(localDomain);
    interchainGasPaymaster = abacus.interchainGasPaymaster(localDomain);
  });

  it('Cannot be initialized twice', async () => {
    await expect(
      router.initialize(ethers.constants.AddressZero),
    ).to.be.revertedWith('Initializable: contract is already initialized');
  });

  describe('when not in recovery mode', async () => {
    it('governor is the owner', async () => {
      expect(await router.owner()).to.equal(governor.address);
    });

    it('governor can set local recovery manager', async () => {
      expect(await router.recoveryManager()).to.equal(recoveryManager.address);
      await router.transferOwnership(router.address);
      expect(await router.recoveryManager()).to.equal(router.address);
      expect(await router.recoveryActiveAt()).to.equal(0);
    });

    it('governor can make local calls', async () => {
      const value = 12;
      const call = formatCall(testSet, 'set', [value]);
      await router.call([call]);
      expect(await testSet.get()).to.equal(value);
    });

    it('governor can set local governor', async () => {
      expect(await router.governor()).to.equal(governor.address);
      await router.setGovernor(ethers.constants.AddressZero);
      expect(await router.governor()).to.equal(ethers.constants.AddressZero);
    });

    it('governor can set local abacusConnectionManager', async () => {
      expect(await router.abacusConnectionManager()).to.equal(
        abacus.abacusConnectionManager(localDomain).address,
      );
      await router.setAbacusConnectionManager(ethers.constants.AddressZero);
      expect(await router.abacusConnectionManager()).to.equal(
        ethers.constants.AddressZero,
      );
    });

    it('governor can enroll local remote router', async () => {
      expect(await router.routers(testDomain)).to.equal(
        ethers.constants.HashZero,
      );
      const newRouter = utils.addressToBytes32(router.address);
      await router.enrollRemoteRouter(testDomain, newRouter);
      expect(await router.routers(testDomain)).to.equal(newRouter);
    });

    it('governor can make remote calls', async () => {
      const value = 13;
      const call = formatCall(testSet, 'set', [value]);
      await router.callRemote(domains[1], [call]);
      await abacus.processMessages();
      expect(await testSet.get()).to.equal(value);
    });

    it('allows interchain gas payment for remote calls', async () => {
      const leafIndex = await outbox.count();
      const value = 13;
      const call = formatCall(testSet, 'set', [value]);
      await expect(
        await router.callRemote(domains[1], [call], {
          value: testInterchainGasPayment,
        }),
      )
        .to.emit(interchainGasPaymaster, 'GasPayment')
        .withArgs(leafIndex, testInterchainGasPayment);
    });

    it('calls Outbox#checkpoint for remote calls', async () => {
      const value = 13;
      const call = formatCall(testSet, 'set', [value]);
      await expect(await router.callRemote(domains[1], [call])).to.emit(
        outbox,
        'Checkpoint',
      );
    });

    it('governor can set remote governor', async () => {
      const newGovernor = governor.address;
      expect(await remote.governor()).to.not.equal(newGovernor);
      await router.setGovernorRemote(remoteDomain, newGovernor);
      await abacus.processMessages();
      expect(await remote.governor()).to.equal(newGovernor);
    });

    it('allows interchain gas payment when setting a remote governor', async () => {
      const newGovernor = governor.address;
      const leafIndex = await outbox.count();
      await expect(
        router.setGovernorRemote(remoteDomain, newGovernor, {
          value: testInterchainGasPayment,
        }),
      )
        .to.emit(interchainGasPaymaster, 'GasPayment')
        .withArgs(leafIndex, testInterchainGasPayment);
    });

    it('calls Outbox#checkpoint when setting a remote governor', async () => {
      const newGovernor = governor.address;
      await expect(router.setGovernorRemote(remoteDomain, newGovernor)).to.emit(
        outbox,
        'Checkpoint',
      );
    });

    it('governor can set remote abacusConnectionManager', async () => {
      const newConnectionManager = ethers.constants.AddressZero;
      expect(await remote.abacusConnectionManager()).to.not.equal(
        newConnectionManager,
      );
      await router.setAbacusConnectionManagerRemote(
        remoteDomain,
        newConnectionManager,
      );
      await abacus.processMessages();
      expect(await remote.abacusConnectionManager()).to.equal(
        newConnectionManager,
      );
    });

    it('allows interchain gas payment when setting a remote abacusConnectionManager', async () => {
      const leafIndex = await outbox.count();
      await expect(
        router.setAbacusConnectionManagerRemote(
          remoteDomain,
          ethers.constants.AddressZero,
          { value: testInterchainGasPayment },
        ),
      )
        .to.emit(interchainGasPaymaster, 'GasPayment')
        .withArgs(leafIndex, testInterchainGasPayment);
    });

    it('calls Outbox#checkpoint when setting a remote abacusConnectionManager', async () => {
      await expect(
        router.setAbacusConnectionManagerRemote(
          remoteDomain,
          ethers.constants.AddressZero,
        ),
      ).to.emit(outbox, 'Checkpoint');
    });

    it('governor can enroll remote remote router', async () => {
      expect(await remote.routers(testDomain)).to.equal(
        ethers.constants.HashZero,
      );
      const newRouter = utils.addressToBytes32(router.address);
      await router.enrollRemoteRouterRemote(
        remoteDomain,
        testDomain,
        newRouter,
      );
      await abacus.processMessages();
      expect(await remote.routers(testDomain)).to.equal(newRouter);
    });

    it('allows interchain gas payment when enrolling a remote router', async () => {
      const leafIndex = await outbox.count();
      const newRouter = utils.addressToBytes32(router.address);
      await expect(
        router.enrollRemoteRouterRemote(remoteDomain, testDomain, newRouter, {
          value: testInterchainGasPayment,
        }),
      )
        .to.emit(interchainGasPaymaster, 'GasPayment')
        .withArgs(leafIndex, testInterchainGasPayment);
    });

    it('calls Outbox#checkpoint when enrolling a remote router', async () => {
      const newRouter = utils.addressToBytes32(router.address);
      await expect(
        router.enrollRemoteRouterRemote(remoteDomain, testDomain, newRouter),
      ).to.emit(outbox, 'Checkpoint');
    });

    it('governor cannot initiate recovery', async () => {
      await expect(router.initiateRecoveryTimelock()).to.be.revertedWith(
        '!recoveryManager',
      );
    });

    it('governor cannot exit recovery', async () => {
      await expect(router.exitRecovery()).to.be.revertedWith('!recovery');
    });

    it('recoveryManager can set local recovery manager', async () => {
      expect(await router.recoveryManager()).to.equal(recoveryManager.address);
      await router.connect(recoveryManager).transferOwnership(router.address);
      expect(await router.recoveryManager()).to.equal(router.address);
      expect(await router.recoveryActiveAt()).to.equal(0);
    });

    it('recovery manager cannot make local calls', async () => {
      const value = 12;
      const call = formatCall(testSet, 'set', [value]);
      await expect(
        router.connect(recoveryManager).call([call]),
      ).to.be.revertedWith(ONLY_OWNER_REVERT_MESSAGE);
    });

    it('recovery manager cannot set local governor', async () => {
      await expect(
        router
          .connect(recoveryManager)
          .setGovernor(ethers.constants.AddressZero),
      ).to.be.revertedWith(ONLY_OWNER_REVERT_MESSAGE);
    });

    it('recovery manager cannot set local abacusConnectionManager', async () => {
      await expect(
        router
          .connect(recoveryManager)
          .setAbacusConnectionManager(router.address),
      ).to.be.revertedWith(ONLY_OWNER_REVERT_MESSAGE);
    });

    it('recovery manager cannot enroll local remote router', async () => {
      await expect(
        router
          .connect(recoveryManager)
          .enrollRemoteRouter(
            testDomain,
            utils.addressToBytes32(router.address),
          ),
      ).to.be.revertedWith(ONLY_OWNER_REVERT_MESSAGE);
    });

    it('recovery manager cannot make remote calls', async () => {
      const value = 13;
      const call = formatCall(testSet, 'set', [value]);
      await expect(
        router.connect(recoveryManager).callRemote(domains[1], [call]),
      ).to.be.revertedWith('!governor');
    });

    it('recovery manager cannot set remote governor', async () => {
      await expect(
        router
          .connect(recoveryManager)
          .setGovernorRemote(remoteDomain, router.address),
      ).to.be.revertedWith('!governor');
    });

    it('recovery manager cannot set remote abacusConnectionManager', async () => {
      await expect(
        router
          .connect(recoveryManager)
          .setAbacusConnectionManagerRemote(remoteDomain, router.address),
      ).to.be.revertedWith('!governor');
    });

    it('recovery manager cannot enroll remote remote router', async () => {
      await expect(
        router
          .connect(recoveryManager)
          .enrollRemoteRouterRemote(
            testDomain,
            testDomain,
            utils.addressToBytes32(router.address),
          ),
      ).to.be.revertedWith('!governor');
    });

    it('recovery manager can initiate recovery', async () => {
      await expect(
        router.connect(recoveryManager).initiateRecoveryTimelock(),
      ).to.emit(router, 'InitiateRecovery');
    });

    it('recovery manager cannot exit recovery', async () => {
      await expect(
        router.connect(recoveryManager).exitRecovery(),
      ).to.be.revertedWith('!recovery');
    });
  });

  describe('when in recovery mode', async () => {
    beforeEach(async () => {
      router = router.connect(recoveryManager);
      await router.initiateRecoveryTimelock();
      expect(await router.inRecovery()).to.be.false;
      await increaseTimestampBy(ethers.provider, recoveryTimelock);
      expect(await router.inRecovery()).to.be.true;
    });

    it('recovery manager is the owner', async () => {
      expect(await router.owner()).to.equal(recoveryManager.address);
    });

    it('recovery manager can set local recovery manager', async () => {
      const recoveryActiveAt = await router.recoveryActiveAt();
      expect(await router.recoveryManager()).to.equal(recoveryManager.address);
      await router.transferOwnership(router.address);
      expect(await router.recoveryManager()).to.equal(router.address);
      expect(await router.recoveryActiveAt()).to.equal(recoveryActiveAt);
    });

    it('recovery manager can make local calls', async () => {
      const value = 12;
      const call = formatCall(testSet, 'set', [value]);
      await router.call([call]);
      expect(await testSet.get()).to.equal(value);
    });

    it('recovery manager can set local governor', async () => {
      expect(await router.governor()).to.equal(governor.address);
      await router.setGovernor(ethers.constants.AddressZero);
      expect(await router.governor()).to.equal(ethers.constants.AddressZero);
    });

    it('recovery manager can set local abacusConnectionManager', async () => {
      expect(await router.abacusConnectionManager()).to.equal(
        abacus.abacusConnectionManager(localDomain).address,
      );
      await router.setAbacusConnectionManager(ethers.constants.AddressZero);
      expect(await router.abacusConnectionManager()).to.equal(
        ethers.constants.AddressZero,
      );
    });

    it('recovery manager can enroll local remote router', async () => {
      expect(await router.routers(testDomain)).to.equal(
        ethers.constants.HashZero,
      );
      const newRouter = utils.addressToBytes32(router.address);
      await router.enrollRemoteRouter(testDomain, newRouter);
      expect(await router.routers(testDomain)).to.equal(newRouter);
    });

    it('recovery manager cannot make remote calls', async () => {
      const value = 13;
      const call = formatCall(testSet, 'set', [value]);
      await expect(router.callRemote(domains[1], [call])).to.be.revertedWith(
        '!governor',
      );
    });

    it('recovery manager cannot set remote governor', async () => {
      await expect(
        router.setGovernorRemote(remoteDomain, router.address),
      ).to.be.revertedWith('!governor');
    });

    it('recovery manager cannot set remote abacusConnectionManager', async () => {
      await expect(
        router.setAbacusConnectionManagerRemote(remoteDomain, router.address),
      ).to.be.revertedWith('!governor');
    });

    it('recovery manager cannot enroll remote remote router', async () => {
      await expect(
        router.enrollRemoteRouterRemote(
          remoteDomain,
          testDomain,
          utils.addressToBytes32(router.address),
        ),
      ).to.be.revertedWith('!governor');
    });

    it('recovery manager cannot initiate recovery', async () => {
      await expect(router.initiateRecoveryTimelock()).to.be.revertedWith(
        'recovery',
      );
    });

    it('recovery manager can exit recovery ', async () => {
      await expect(router.exitRecovery()).to.emit(router, 'ExitRecovery');
      expect(await router.inRecovery()).to.be.false;
    });

    it('governor cannot make local calls', async () => {
      const value = 12;
      const call = formatCall(testSet, 'set', [value]);
      await expect(router.connect(governor).call([call])).to.be.revertedWith(
        ONLY_OWNER_REVERT_MESSAGE,
      );
    });

    it('governor cannot set local governor', async () => {
      await expect(
        router.connect(governor).setGovernor(ethers.constants.AddressZero),
      ).to.be.revertedWith(ONLY_OWNER_REVERT_MESSAGE);
    });

    it('governor cannot set local recovery manager', async () => {
      await expect(
        router.connect(governor).transferOwnership(router.address),
      ).to.be.revertedWith(ONLY_OWNER_REVERT_MESSAGE);
    });

    it('governor cannot set local abacusConnectionManager', async () => {
      await expect(
        router.connect(governor).setAbacusConnectionManager(router.address),
      ).to.be.revertedWith(ONLY_OWNER_REVERT_MESSAGE);
    });

    it('governor cannot enroll local remote router', async () => {
      await expect(
        router
          .connect(governor)
          .enrollRemoteRouter(
            testDomain,
            utils.addressToBytes32(router.address),
          ),
      ).to.be.revertedWith(ONLY_OWNER_REVERT_MESSAGE);
    });

    it('governor cannot make remote calls', async () => {
      const value = 13;
      const call = formatCall(testSet, 'set', [value]);
      await expect(
        router.connect(governor).callRemote(domains[1], [call]),
      ).to.be.revertedWith('recovery');
    });

    it('governor cannot set remote governor', async () => {
      await expect(
        router
          .connect(governor)
          .setGovernorRemote(remoteDomain, router.address),
      ).to.be.revertedWith('recovery');
    });

    it('governor cannot set remote abacusConnectionManager', async () => {
      await expect(
        router
          .connect(governor)
          .setAbacusConnectionManagerRemote(remoteDomain, router.address),
      ).to.be.revertedWith('recovery');
    });

    it('governor cannot enroll remote remote router', async () => {
      await expect(
        router
          .connect(governor)
          .enrollRemoteRouterRemote(
            remoteDomain,
            testDomain,
            utils.addressToBytes32(router.address),
          ),
      ).to.be.revertedWith('recovery');
    });

    it('governor cannot initiate recovery', async () => {
      await expect(
        router.connect(governor).initiateRecoveryTimelock(),
      ).to.be.revertedWith('recovery');
    });

    it('governor cannot exit recovery', async () => {
      await expect(router.connect(governor).exitRecovery()).to.be.revertedWith(
        '!recoveryManager',
      );
    });
  });
});
