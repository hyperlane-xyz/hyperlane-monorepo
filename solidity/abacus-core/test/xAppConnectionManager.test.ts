import { ethers, abacus } from 'hardhat';
import { expect } from 'chai';

import {
  TestHome__factory,
  TestReplica__factory,
  XAppConnectionManager,
  XAppConnectionManager__factory,
  TestReplica,
} from '../typechain';
import { Validator } from './lib/core';
import { Signer } from './lib/types';

const signedFailureTestCases = require('../../../vectors/signedFailure.json');

const ONLY_OWNER_REVERT_MSG = 'Ownable: caller is not the owner';
const localDomain = 1000;
const remoteDomain = 2000;
const processGas = 850000;
const reserveGas = 15000;

describe('XAppConnectionManager', async () => {
  let connectionManager: XAppConnectionManager,
    enrolledReplica: TestReplica,
    signer: Signer,
    validator: Validator;

  before(async () => {
    [signer] = await ethers.getSigners();
    validator = await Validator.fromSigner(signer, localDomain);
  });

  beforeEach(async () => {
    const homeFactory = new TestHome__factory(signer);
    const home = await homeFactory.deploy(localDomain);

    const replicaFactory = new TestReplica__factory(signer);
    enrolledReplica = await replicaFactory.deploy(
      localDomain,
      processGas,
      reserveGas,
    );
    await enrolledReplica.initialize(remoteDomain, validator.address, 0);

    const connectionManagerFactory = new XAppConnectionManager__factory(signer);
    connectionManager = await connectionManagerFactory.deploy();
    await connectionManager.setHome(home.address);
    await connectionManager.enrollReplica(
      enrolledReplica.address,
      remoteDomain,
    );
  });

  it('Returns the local domain', async () => {
    expect(await connectionManager!.localDomain()).to.equal(localDomain);
  });

  it('onlyOwner function rejects call from non-owner', async () => {
    const [nonHome, nonOwner] = await ethers.getSigners();
    await expect(
      connectionManager.connect(nonOwner).setHome(nonHome.address),
    ).to.be.revertedWith(ONLY_OWNER_REVERT_MSG);
  });

  it('isReplica returns true for enrolledReplica and false for non-enrolled Replica', async () => {
    const [nonEnrolledReplica] = await ethers.getSigners();
    expect(await connectionManager.isReplica(enrolledReplica.address)).to.be
      .true;
    expect(await connectionManager.isReplica(nonEnrolledReplica.address)).to.be
      .false;
  });

  it('Allows owner to set the home', async () => {
    const homeFactory = new TestHome__factory(signer);
    const newHome = await homeFactory.deploy(localDomain);

    await connectionManager.setHome(newHome.address);
    expect(await connectionManager.home()).to.equal(newHome.address);
  });

  it('Owner can enroll a replica', async () => {
    const newRemoteDomain = 3000;
    const replicaFactory = new TestReplica__factory(signer);
    const newReplica = await replicaFactory.deploy(
      localDomain,
      processGas,
      reserveGas,
    );

    // Assert new replica not considered replica before enrolled
    expect(await connectionManager.isReplica(newReplica.address)).to.be.false;

    await expect(
      connectionManager.enrollReplica(newReplica.address, newRemoteDomain),
    ).to.emit(connectionManager, 'ReplicaEnrolled');

    expect(await connectionManager.domainToReplica(newRemoteDomain)).to.equal(
      newReplica.address,
    );
    expect(
      await connectionManager.replicaToDomain(newReplica.address),
    ).to.equal(newRemoteDomain);
    expect(await connectionManager.isReplica(newReplica.address)).to.be.true;
  });

  it('Owner can unenroll a replica', async () => {
    await expect(
      connectionManager.unenrollReplica(enrolledReplica.address),
    ).to.emit(connectionManager, 'ReplicaUnenrolled');

    expect(
      await connectionManager.replicaToDomain(enrolledReplica.address),
    ).to.equal(0);
    expect(await connectionManager.domainToReplica(localDomain)).to.equal(
      ethers.constants.AddressZero,
    );
    expect(await connectionManager.isReplica(enrolledReplica.address)).to.be
      .false;
  });
});
