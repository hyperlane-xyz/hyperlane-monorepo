/* eslint-disable @typescript-eslint/no-floating-promises */
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { BigNumberish, ContractTransaction } from 'ethers';
import { ethers } from 'hardhat';

import { utils } from '@hyperlane-xyz/utils';

import {
  TestInterchainGasPaymaster,
  TestInterchainGasPaymaster__factory,
  TestMailbox,
  TestMailbox__factory,
  TestMultisigIsm__factory,
  TestRouter,
  TestRouter__factory,
} from '../types';

import { inferMessageValues } from './lib/mailboxes';

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
      signer.address,
    );
    router = await new TestRouter__factory(signer).deploy();
  });

  describe('#initialize', () => {
    it('should set the mailbox', async () => {
      await router.initialize(mailbox.address, igp.address);
      expect(await router.mailbox()).to.equal(mailbox.address);
    });

    it('should set the IGP', async () => {
      await router.initialize(mailbox.address, igp.address);
      expect(await router.interchainGasPaymaster()).to.equal(igp.address);
    });

    it('should transfer owner to deployer', async () => {
      await router.initialize(mailbox.address, igp.address);
      expect(await router.owner()).to.equal(signer.address);
    });

    it('should use overloaded initialize', async () => {
      await expect(router.initialize(mailbox.address, igp.address)).to.emit(
        router,
        'InitializeOverload',
      );
    });

    it('cannot be initialized twice', async () => {
      await router.initialize(mailbox.address, igp.address);
      await expect(
        router.initialize(mailbox.address, igp.address),
      ).to.be.revertedWith('Initializable: contract is already initialized');
    });
  });

  describe('when initialized', () => {
    beforeEach(async () => {
      await router.initialize(mailbox.address, igp.address);
      const ism = await new TestMultisigIsm__factory(signer).deploy();
      await ism.setAccept(true);
      await mailbox.initialize(signer.address, ism.address);
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
      beforeEach(async () => {
        // Enroll a remote router on the destination domain.
        // The address is arbitrary because no messages will actually be processed.
        await router.enrollRemoteRouter(
          destination,
          utils.addressToBytes32(nonOwner.address),
        );
      });

      // Helper for testing different variations of dispatch functions
      const runDispatchFunctionTests = async (
        dispatchFunction: (
          destinationDomain: number,
          gasPaymentParams: GasPaymentParams,
        ) => Promise<ContractTransaction>,
        expectGasPayment: boolean,
      ) => {
        // Allows a Chai Assertion to be programmatically negated
        const expectAssertion = (
          assertion: Chai.Assertion,
          expected: boolean,
        ) => {
          return expected ? assertion : assertion.not;
        };

        const testGasPaymentParams: GasPaymentParams = {
          gasAmount: 4321,
          payment: 43210,
          refundAddress: '0xc0ffee0000000000000000000000000000000000',
        };

        it('dispatches a message', async () => {
          await expect(
            dispatchFunction(destination, testGasPaymentParams),
          ).to.emit(mailbox, 'Dispatch');
        });

        it(`${
          expectGasPayment ? 'pays' : 'does not pay'
        } interchain gas`, async () => {
          const { id } = await inferMessageValues(
            mailbox,
            router.address,
            destination,
            await router.routers(destination),
            '',
          );
          const assertion = expectAssertion(
            expect(dispatchFunction(destination, testGasPaymentParams)).to,
            expectGasPayment,
          );
          await assertion
            .emit(igp, 'GasPayment')
            .withArgs(
              id,
              testGasPaymentParams.gasAmount,
              testGasPaymentParams.payment,
            );
        });

        it('reverts when dispatching a message to an unenrolled remote router', async () => {
          await expect(
            dispatchFunction(destinationWithoutRouter, testGasPaymentParams),
          ).to.be.revertedWith(
            `No router enrolled for domain. Did you specify the right domain ID?`,
          );
        });
      };

      describe('#dispatch', () => {
        runDispatchFunctionTests(
          (destinationDomain) => router.dispatch(destinationDomain, '0x'),
          false,
        );
      });

      describe('#dispatchWithGas', () => {
        runDispatchFunctionTests(
          (destinationDomain, gasPaymentParams) =>
            router.dispatchWithGas(
              destinationDomain,
              '0x',
              gasPaymentParams.gasAmount,
              gasPaymentParams.payment,
              gasPaymentParams.refundAddress,
              {
                value: gasPaymentParams.payment,
              },
            ),
          true,
        );
      });
    });
  });
});
