/* eslint-disable @typescript-eslint/no-floating-promises */
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { BigNumberish, ContractTransaction } from 'ethers';
import { ethers } from 'hardhat';

import { utils } from '@hyperlane-xyz/utils';

import {
  TestInterchainGasPaymaster,
  TestInterchainGasPaymaster__factory,
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

interface GasPaymentParams {
  // The amount of destination gas being paid for
  gasAmount: BigNumberish;
  // The amount of native tokens paid
  payment: BigNumberish;
  refundAddress: string;
}

describe('Router', async () => {
  let router: TestRouter,
    mailbox: TestMailbox,
    igp: TestInterchainGasPaymaster,
    signer: SignerWithAddress,
    nonOwner: SignerWithAddress;

  before(async () => {
    [signer, nonOwner] = await ethers.getSigners();
  });

  beforeEach(async () => {
    const mailboxFactory = new TestMailbox__factory(signer);
    mailbox = await mailboxFactory.deploy(origin);
    igp = await new TestInterchainGasPaymaster__factory(signer).deploy(
      nonOwner.address,
    );
    const requiredHook = await new TestMerkleTreeHook__factory(signer).deploy(
      mailbox.address,
    );
    const defaultIsm = await new TestIsm__factory(signer).deploy();
    await mailbox.initialize(
      signer.address,
      defaultIsm.address,
      igp.address,
      requiredHook.address,
    );
    router = await new TestRouter__factory(signer).deploy();
  });

  describe('#initialize', () => {
    it('should set the mailbox', async () => {
      await router.initialize(mailbox.address);
      expect(await router.mailbox()).to.equal(mailbox.address);
    });

    it('should transfer owner to deployer', async () => {
      await router.initialize(mailbox.address);
      expect(await router.owner()).to.equal(signer.address);
    });

    it('cannot be initialized twice', async () => {
      await router.initialize(mailbox.address);
      await expect(router.initialize(mailbox.address)).to.be.revertedWith(
        'Initializable: contract is already initialized',
      );
    });
  });

  describe('when initialized', () => {
    beforeEach(async () => {
      await router.initialize(mailbox.address);
    });

    it('accepts message from enrolled mailbox and router', async () => {
      const sender = utils.addressToBytes32(nonOwner.address);
      await router.enrollRemoteRouter(origin, sender);
      const recipient = utils.addressToBytes32(router.address);
      // Does not revert.
      await mailbox.testHandle(origin, sender, recipient, body);
    });

    it('rejects message from unenrolled mailbox', async () => {
      await expect(
        router.handle(origin, utils.addressToBytes32(nonOwner.address), body),
      ).to.be.revertedWith('!mailbox');
    });

    it('rejects message from unenrolled router', async () => {
      const sender = utils.addressToBytes32(nonOwner.address);
      const recipient = utils.addressToBytes32(router.address);
      await expect(
        mailbox.testHandle(origin, sender, recipient, body),
      ).to.be.revertedWith(
        `No router enrolled for domain. Did you specify the right domain ID?`,
      );
    });

    it('owner can enroll remote router', async () => {
      const remote = nonOwner.address;
      const remoteBytes = utils.addressToBytes32(nonOwner.address);
      expect(await router.isRemoteRouter(origin, remoteBytes)).to.equal(false);
      await expect(router.mustHaveRemoteRouter(origin)).to.be.revertedWith(
        `No router enrolled for domain. Did you specify the right domain ID?`,
      );
      await router.enrollRemoteRouter(origin, utils.addressToBytes32(remote));
      expect(await router.isRemoteRouter(origin, remoteBytes)).to.equal(true);
      expect(await router.mustHaveRemoteRouter(origin)).to.equal(remoteBytes);
    });

    it('owner can enroll remote router using batch function', async () => {
      const remote = nonOwner.address;
      const remoteBytes = utils.addressToBytes32(nonOwner.address);
      expect(await router.isRemoteRouter(origin, remoteBytes)).to.equal(false);
      await expect(router.mustHaveRemoteRouter(origin)).to.be.revertedWith(
        `No router enrolled for domain. Did you specify the right domain ID?`,
      );
      await router.enrollRemoteRouters(
        [origin],
        [utils.addressToBytes32(remote)],
      );
      expect(await router.isRemoteRouter(origin, remoteBytes)).to.equal(true);
      expect(await router.mustHaveRemoteRouter(origin)).to.equal(remoteBytes);
    });

    describe('#domains', () => {
      it('returns the domains', async () => {
        await router.enrollRemoteRouters(
          [origin, destination],
          [
            utils.addressToBytes32(nonOwner.address),
            utils.addressToBytes32(nonOwner.address),
          ],
        );
        expect(await router.domains()).to.deep.equal([origin, destination]);
      });
    });

    it('non-owner cannot enroll remote router', async () => {
      await expect(
        router
          .connect(nonOwner)
          .enrollRemoteRouter(origin, utils.addressToBytes32(nonOwner.address)),
      ).to.be.revertedWith(ONLY_OWNER_REVERT_MSG);
    });

    describe('dispatch functions', () => {
      let payment: BigNumberish;

      beforeEach(async () => {
        // Enroll a remote router on the destination domain.
        // The address is arbitrary because no messages will actually be processed.
        await router.enrollRemoteRouter(
          destination,
          utils.addressToBytes32(nonOwner.address),
        );
        const recipient = utils.addressToBytes32(router.address);
        payment = await mailbox.quoteDispatch(destination, recipient, body);
      });

      describe('#dispatch', () => {
        it('dispatches a message', async () => {
          await expect(
            router.dispatch(destination, body, { value: payment }),
          ).to.emit(mailbox, 'Dispatch');
        });

        it('reverts on insufficient payment', async () => {
          await expect(
            router.dispatch(destination, body, { value: payment.sub(1) }),
          ).to.be.revertedWith('insufficient interchain gas payment');
        });

        it('reverts when dispatching a message to an unenrolled remote router', async () => {
          await expect(
            router.dispatch(destinationWithoutRouter, body),
          ).to.be.revertedWith(
            `No router enrolled for domain. Did you specify the right domain ID?`,
          );
        });
      });

      describe('#dispatchWithGas', () => {
        const testGasPaymentParams = {
          gasAmount: 4321,
          payment: 43210,
          refundAddress: '0xc0ffee0000000000000000000000000000000000',
        };

        it('dispatches a message', async () => {
          await expect(
            router.dispatchWithGas(
              destination,
              body,
              testGasPaymentParams.gasAmount,
              testGasPaymentParams.payment,
              testGasPaymentParams.refundAddress,
              { value: testGasPaymentParams.payment },
            ),
          ).to.emit(mailbox, 'Dispatch');
        });

        it('uses custom igp metadata', async () => {
          const tx = await router.dispatchWithGas(
            destination,
            body,
            testGasPaymentParams.gasAmount,
            testGasPaymentParams.payment,
            testGasPaymentParams.refundAddress,
            { value: testGasPaymentParams.payment },
          );

          const messageId = await mailbox.latestDispatchedId();
          const required = await igp.quoteGasPayment(
            destination,
            testGasPaymentParams.gasAmount,
          );
          expect(tx)
            .to.emit(igp, 'GasPayment')
            .withArgs(messageId, testGasPaymentParams.gasAmount, required);
        });
      });
    });
  });
});
