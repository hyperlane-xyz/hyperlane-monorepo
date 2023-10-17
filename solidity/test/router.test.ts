/* eslint-disable @typescript-eslint/no-floating-promises */
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { BigNumberish } from 'ethers';
import { ethers } from 'hardhat';

import { addressToBytes32 } from '@hyperlane-xyz/utils';

import {
  TestInterchainGasPaymaster,
  TestInterchainGasPaymaster__factory,
  TestIsm,
  TestIsm__factory,
  TestMailbox,
  TestMailbox__factory,
  TestMerkleTreeHook__factory,
  TestRouter,
  TestRouter__factory,
} from '../types';

const ONLY_OWNER_REVERT_MSG = 'Ownable: caller is not the owner';
const origin = 1;
const destination = 2;
const destinationWithoutRouter = 3;
const body = '0xdeadbeef';

describe('Router', async () => {
  let router: TestRouter,
    mailbox: TestMailbox,
    igp: TestInterchainGasPaymaster,
    defaultIsm: TestIsm,
    signer: SignerWithAddress,
    nonOwner: SignerWithAddress;

  before(async () => {
    [signer, nonOwner] = await ethers.getSigners();
  });

  beforeEach(async () => {
    const mailboxFactory = new TestMailbox__factory(signer);
    mailbox = await mailboxFactory.deploy(origin);
    igp = await new TestInterchainGasPaymaster__factory(signer).deploy();
    const requiredHook = await new TestMerkleTreeHook__factory(signer).deploy(
      mailbox.address,
    );
    defaultIsm = await new TestIsm__factory(signer).deploy();
    await mailbox.initialize(
      signer.address,
      defaultIsm.address,
      igp.address,
      requiredHook.address,
    );
    router = await new TestRouter__factory(signer).deploy(mailbox.address);
    await router.initialize(igp.address, defaultIsm.address);
  });

  describe('#initialize', () => {
    it('should set the hook', async () => {
      expect(await router.hook()).to.equal(igp.address);
    });

    it('should set the ism', async () => {
      expect(await router.interchainSecurityModule()).to.equal(
        defaultIsm.address,
      );
    });

    it('should transfer owner to deployer', async () => {
      expect(await router.owner()).to.equal(signer.address);
    });

    it('cannot be initialized twice', async () => {
      await expect(
        router.initialize(mailbox.address, defaultIsm.address),
      ).to.be.revertedWith('Initializable: contract is already initialized');
    });
  });

  it('accepts message from enrolled mailbox and router', async () => {
    const sender = addressToBytes32(nonOwner.address);
    await router.enrollRemoteRouter(origin, sender);
    const recipient = addressToBytes32(router.address);
    // Does not revert.
    await mailbox.testHandle(origin, sender, recipient, body);
  });

  it('rejects message from unenrolled mailbox', async () => {
    await expect(
      router.handle(origin, addressToBytes32(nonOwner.address), body),
    ).to.be.revertedWith('MailboxClient: sender not mailbox');
  });

  it('rejects message from unenrolled router', async () => {
    const sender = addressToBytes32(nonOwner.address);
    const recipient = addressToBytes32(router.address);
    await expect(
      mailbox.testHandle(origin, sender, recipient, body),
    ).to.be.revertedWith(`No router enrolled for domain: ${origin}`);
  });

  it('owner can enroll remote router', async () => {
    const remote = nonOwner.address;
    const remoteBytes = addressToBytes32(nonOwner.address);
    expect(await router.isRemoteRouter(origin, remoteBytes)).to.equal(false);
    await expect(router.mustHaveRemoteRouter(origin)).to.be.revertedWith(
      `No router enrolled for domain: ${origin}`,
    );
    await router.enrollRemoteRouter(origin, addressToBytes32(remote));
    expect(await router.isRemoteRouter(origin, remoteBytes)).to.equal(true);
    expect(await router.mustHaveRemoteRouter(origin)).to.equal(remoteBytes);
  });

  it('owner can unenroll remote router', async () => {
    const remote = nonOwner.address;
    const remoteBytes = addressToBytes32(remote);
    await expect(router.unenrollRemoteRouter(origin)).to.be.revertedWith(
      `No router enrolled for domain: ${origin}`,
    );
    await router.enrollRemoteRouter(origin, remoteBytes);
    await router.unenrollRemoteRouter(origin);
    expect(await router.isRemoteRouter(origin, remoteBytes)).to.equal(false);
  });

  it('owner can enroll remote router using batch function', async () => {
    const remote = nonOwner.address;
    const remoteBytes = addressToBytes32(nonOwner.address);
    expect(await router.isRemoteRouter(origin, remoteBytes)).to.equal(false);
    await expect(router.mustHaveRemoteRouter(origin)).to.be.revertedWith(
      `No router enrolled for domain: ${origin}`,
    );
    await router.enrollRemoteRouters([origin], [addressToBytes32(remote)]);
    expect(await router.isRemoteRouter(origin, remoteBytes)).to.equal(true);
    expect(await router.mustHaveRemoteRouter(origin)).to.equal(remoteBytes);
  });

  it('owner can unenroll remote router using batch function', async () => {
    const remote = nonOwner.address;
    const remoteBytes = addressToBytes32(remote);
    await expect(router.unenrollRemoteRouters([origin])).to.be.revertedWith(
      `No router enrolled for domain: ${origin}`,
    );
    await router.enrollRemoteRouter(origin, remoteBytes);
    await router.unenrollRemoteRouters([origin]);
    expect(await router.isRemoteRouter(origin, remoteBytes)).to.equal(false);
  });

  describe('#domains', () => {
    it('returns the domains', async () => {
      await router.enrollRemoteRouters(
        [origin, destination],
        [
          addressToBytes32(nonOwner.address),
          addressToBytes32(nonOwner.address),
        ],
      );
      expect(await router.domains()).to.deep.equal([origin, destination]);
    });
  });

  it('non-owner cannot enroll remote router', async () => {
    await expect(
      router
        .connect(nonOwner)
        .enrollRemoteRouter(origin, addressToBytes32(nonOwner.address)),
    ).to.be.revertedWith(ONLY_OWNER_REVERT_MSG);
  });

  describe('#dispatch', () => {
    let payment: BigNumberish;

    beforeEach(async () => {
      // Enroll a remote router on the destination domain.
      // The address is arbitrary because no messages will actually be processed.
      await router.enrollRemoteRouter(
        destination,
        addressToBytes32(nonOwner.address),
      );
      const recipient = addressToBytes32(router.address);
      payment = await mailbox['quoteDispatch(uint32,bytes32,bytes)'](
        destination,
        recipient,
        body,
      );
    });

    it('dispatches a message', async () => {
      await expect(
        router.dispatch(destination, body, { value: payment }),
      ).to.emit(mailbox, 'Dispatch');
    });

    it('reverts on insufficient payment', async () => {
      await expect(
        router.dispatch(destination, body, { value: payment.sub(1) }),
      ).to.be.revertedWith('IGP: insufficient interchain gas payment');
    });

    it('reverts when dispatching a message to an unenrolled remote router', async () => {
      await expect(
        router.dispatch(destinationWithoutRouter, body),
      ).to.be.revertedWith(
        `No router enrolled for domain: ${destinationWithoutRouter}`,
      );
    });
  });
});
