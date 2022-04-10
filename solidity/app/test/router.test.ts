import { ethers } from 'hardhat';
import { expect } from 'chai';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import {
  Outbox__factory,
  XAppConnectionManager,
  XAppConnectionManager__factory,
} from '@abacus-network/core';
import { utils } from '@abacus-network/utils';

import { TestRouter, TestRouter__factory } from '../types';

const ONLY_OWNER_REVERT_MSG = 'Ownable: caller is not the owner';
const origin = 1;
const destination = 2;
const message = '0xdeadbeef';

describe('Router', async () => {
  let router: TestRouter,
    connectionManager: XAppConnectionManager,
    signer: SignerWithAddress,
    nonOwner: SignerWithAddress;

  before(async () => {
    [signer, nonOwner] = await ethers.getSigners();
  });

  beforeEach(async () => {
    const connectionManagerFactory = new XAppConnectionManager__factory(signer);
    connectionManager = await connectionManagerFactory.deploy();

    const routerFactory = new TestRouter__factory(signer);
    router = await routerFactory.deploy();
    await router.initialize(connectionManager.address);
  });

  it('Cannot be initialized twice', async () => {
    await expect(
      router.initialize(ethers.constants.AddressZero),
    ).to.be.revertedWith('Initializable: contract is already initialized');
  });

  it('accepts message from enrolled inbox and router', async () => {
    await connectionManager.enrollInbox(origin, signer.address);
    const remote = utils.addressToBytes32(nonOwner.address)
    await router.enrollRemoteRouter(origin, remote);
    // Does not revert.
    await router.handle(origin, remote, message);
  });

  it('rejects message from unenrolled inbox', async () => {
    await expect(
      router.handle(origin, utils.addressToBytes32(nonOwner.address), message),
    ).to.be.revertedWith('!inbox');
  });

  it('rejects message from unenrolled router', async () => {
    await connectionManager.enrollInbox(origin, signer.address);
    await expect(
      router.handle(origin, utils.addressToBytes32(nonOwner.address), message),
    ).to.be.revertedWith('!router');
  });

  it('owner can enroll remote router', async () => {
    const remote = nonOwner.address;
    const remoteBytes = utils.addressToBytes32(nonOwner.address);
    expect(await router.isRemoteRouter(origin, remoteBytes)).to.equal(false);
    await expect(router.mustHaveRemoteRouter(origin)).to.be.revertedWith(
      '!router',
    );
    await router.enrollRemoteRouter(origin, utils.addressToBytes32(remote));
    expect(await router.isRemoteRouter(origin, remoteBytes)).to.equal(true);
    expect(await router.mustHaveRemoteRouter(origin)).to.equal(remoteBytes);
  });

  it('non-owner cannot enroll remote router', async () => {
    await expect(
      router.connect(nonOwner).enrollRemoteRouter(origin, utils.addressToBytes32(nonOwner.address))
    ).to.be.revertedWith(ONLY_OWNER_REVERT_MSG);
  });

  it('dispatches message to enrolled remote router', async () => {
    const outboxFactory = new Outbox__factory(signer);
    const outbox = await outboxFactory.deploy(origin);
    await connectionManager.setOutbox(outbox.address);

    const remote = nonOwner.address;
    await router.enrollRemoteRouter(destination, utils.addressToBytes32(remote));
    await expect(router.dispatchToRemoteRouter(destination, message)).to.emit(
      outbox,
      'Dispatch',
    );
  });

  it('reverts when dispatching message to unenrolled remote router', async () => {
    await expect(
      router.dispatchToRemoteRouter(destination, message),
    ).to.be.revertedWith('!router');
  });
});
