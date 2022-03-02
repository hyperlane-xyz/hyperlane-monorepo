import { ethers } from 'hardhat';
import { expect } from 'chai';

import { formatCall, increaseTimestampBy } from './lib/utils';
import { Address, Signer } from '@abacus-network/abacus-sol/test/lib/types';
import { AbacusDeployment } from '@abacus-network/abacus-sol/test/lib/AbacusDeployment';
import { GovernanceDeployment } from './lib/GovernanceDeployment';
import {
  TestSet,
  TestSet__factory,
  GovernanceRouter,
  GovernanceRouter__factory,
} from '../../typechain';

const nullAddress = '0x' + '00'.repeat(20);
const recoveryTimelock = 60 * 60 * 24 * 7;
const localDomain = 1000;
const remoteDomain = 2000;
const domains = [localDomain, remoteDomain];
const ONLY_OWNER_REVERT_MESSAGE = 'Ownable: caller is not the owner';

describe.only('GovernanceRouter', async () => {
  let governor: Signer,
    recoveryManager: Signer,
    router: GovernanceRouter,
    remote: GovernanceRouter,
    testSet: TestSet,
    abacus: AbacusDeployment,
    governance: GovernanceDeployment;

  before(async () => {
    [governor, recoveryManager] = await ethers.getSigners();

    const testSetFactory = new TestSet__factory(governor);
    testSet = await testSetFactory.deploy();
    abacus = await AbacusDeployment.fromDomains(domains, governor);
  });

  beforeEach(async () => {
    governance = await GovernanceDeployment.fromAbacusDeployment(
      abacus,
      governor,
      recoveryManager,
    );
    router = governance.router(localDomain);
    remote = governance.router(remoteDomain);
  });

  it('Cannot be initialized twice', async () => {
    await expect(router.initialize(nullAddress)).to.be.revertedWith(
      'Initializable: contract is already initialized',
    );
  });

  describe('when not in recovery mode', async () => {
    it('governor is the owner', async () => {
      expect(await router.owner()).to.equal(governor.address);
    });

    // TODO: Should it be able to set the remote recovery manager as well?
    it('governor can set local recovery manager', async () => {
      expect(await router.recoveryManager()).to.equal(recoveryManager.address);
      await router.transferOwnership(router.address);
      expect(await router.recoveryManager()).to.equal(router.address);
    });

    it('governor can make local calls', async () => {
      const value = 12;
      const call = await formatCall(testSet, 'set', [value]);
      await router.call([call]);
      expect(await testSet.get()).to.equal(value);
    });

    it('governor can set local governor', async () => {
      expect(await router.governor()).to.equal(governor.address);
      await router.setGovernor(nullAddress);
      expect(await router.governor()).to.equal(nullAddress);
    });

    it('governor can set local xAppConnectionManager', async () => {
      expect(await router.xAppConnectionManager()).to.equal(
        abacus.connectionManager(localDomain).address,
      );
      await router.setXAppConnectionManager(nullAddress);
      expect(await router.xAppConnectionManager()).to.equal(nullAddress);
    });

    it('governor can make remote calls', async () => {
      const value = 13;
      const call = await formatCall(testSet, 'set', [value]);
      await router.callRemote(domains[1], [call]);
      await abacus.processMessages();
      expect(await testSet.get()).to.equal(value);
    });

    it('governor can set remote governor', async () => {
      const newGovernor = governor.address;
      expect(await remote.governor()).to.not.equal(newGovernor);
      await router.setGovernorRemote(remoteDomain, newGovernor);
      await abacus.processMessages();
      expect(await remote.governor()).to.equal(newGovernor);
    });

    it('governor can set remote xAppConnectionManager', async () => {
      const newConnectionManager = nullAddress;
      expect(await remote.xAppConnectionManager()).to.not.equal(
        newConnectionManager,
      );
      await router.setXAppConnectionManagerRemote(
        remoteDomain,
        newConnectionManager,
      );
      await abacus.processMessages();
      expect(await remote.xAppConnectionManager()).to.equal(
        newConnectionManager,
      );
    });

    it('governor cannot initiate recovery', async () => {
      await expect(router.initiateRecoveryTimelock()).to.be.revertedWith(
        '!recoveryManager',
      );
    });

    it('recovery manager cannot make local calls', async () => {
      const value = 12;
      const call = await formatCall(testSet, 'set', [value]);
      await expect(
        router.connect(recoveryManager).call([call])
      ).to.be.revertedWith(ONLY_OWNER_REVERT_MESSAGE);
    });

    it('recovery manager cannot set local governor', async () => {
      await expect(
        router.connect(recoveryManager).setGovernor(nullAddress)
      ).to.be.revertedWith(ONLY_OWNER_REVERT_MESSAGE);
    });

    it('recovery manager cannot set local recovery manager', async () => {
      await expect(
        router.connect(recoveryManager).transferOwnership(router.address)
      ).to.be.revertedWith(ONLY_OWNER_REVERT_MESSAGE);
    });

    it('recovery manager cannot set local xAppConnectionManager', async () => {
      await expect(
        router.connect(recoveryManager).setXAppConnectionManager(router.address)
      ).to.be.revertedWith(ONLY_OWNER_REVERT_MESSAGE);
    });

    it('recovery manager cannot make remote calls', async () => {
      const value = 13;
      const call = await formatCall(testSet, 'set', [value]);
      await expect(
        router.connect(recoveryManager).callRemote(domains[1], [call])
      ).to.be.revertedWith('!governor');
    });

    it('recovery manager cannot set remote governor', async () => {
      await expect(
        router.connect(recoveryManager).setGovernorRemote(remoteDomain, router.address)
      ).to.be.revertedWith('!governor');
    });

    it('recovery manager cannot set remote xAppConnectionManager', async () => {
      await expect(
        router.connect(recoveryManager).setXAppConnectionManagerRemote(remoteDomain, router.address)
      ).to.be.revertedWith('!governor');
    });

    it('recovery manager can initiate recovery', async () => {
      await expect(router.connect(recoveryManager).initiateRecoveryTimelock()).to.emit(router, 'InitiateRecovery');
    });
  });
});
