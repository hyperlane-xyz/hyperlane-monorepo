/* eslint-disable @typescript-eslint/no-floating-promises */
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ContractTransaction } from 'ethers';
import { ethers } from 'hardhat';

import {
  AbacusConnectionManager,
  AbacusConnectionManager__factory,
  InterchainGasPaymaster,
  InterchainGasPaymaster__factory,
  Outbox,
  Outbox__factory,
  TestInbox,
  TestInbox__factory,
  TestMultisigValidatorManager__factory,
} from '@hyperlane-xyz/core';
import { utils } from '@hyperlane-xyz/utils';

import { TestRouter, TestRouter__factory } from '../types';

const ONLY_OWNER_REVERT_MSG = 'Ownable: caller is not the owner';
const origin = 1;
const destination = 2;
const destinationWithoutRouter = 3;
const message = '0xdeadbeef';

describe('Router', async () => {
  let router: TestRouter,
    outbox: Outbox,
    connectionManager: AbacusConnectionManager,
    signer: SignerWithAddress,
    nonOwner: SignerWithAddress;

  before(async () => {
    [signer, nonOwner] = await ethers.getSigners();
  });

  beforeEach(async () => {
    const connectionManagerFactory = new AbacusConnectionManager__factory(
      signer,
    );
    connectionManager = await connectionManagerFactory.deploy();

    const outboxFactory = new Outbox__factory(signer);
    outbox = await outboxFactory.deploy(origin);
    // dispatch dummy message
    await outbox.dispatch(
      destination,
      utils.addressToBytes32(outbox.address),
      '0x',
    );
    await connectionManager.setOutbox(outbox.address);

    router = await new TestRouter__factory(signer).deploy();
  });

  describe('#initialize', () => {
    it('should set the abacus connection manager', async () => {
      await router.initialize(connectionManager.address);
      expect(await router.abacusConnectionManager()).to.equal(
        connectionManager.address,
      );
    });

    it('should transfer owner to deployer', async () => {
      await router.initialize(connectionManager.address);
      expect(await router.owner()).to.equal(signer.address);
    });

    it('should use overloaded initialize', async () => {
      await expect(router.initialize(connectionManager.address)).to.emit(
        router,
        'InitializeOverload',
      );
    });

    it('cannot be initialized twice', async () => {
      await router.initialize(ethers.constants.AddressZero);
      await expect(
        router.initialize(ethers.constants.AddressZero),
      ).to.be.revertedWith('Initializable: contract is already initialized');
    });
  });

  describe('when initialized', () => {
    let inbox: TestInbox;

    beforeEach(async () => {
      await router.initialize(connectionManager.address);
      const validatorManger = await new TestMultisigValidatorManager__factory(
        signer,
      ).deploy(origin, [signer.address], 1);
      inbox = await new TestInbox__factory(signer).deploy(destination);
      await inbox.initialize(origin, validatorManger.address);
    });

    it('accepts message from enrolled inbox and router', async () => {
      await connectionManager.enrollInbox(origin, inbox.address);
      const remote = utils.addressToBytes32(nonOwner.address);
      await router.enrollRemoteRouter(origin, remote);
      const recipient = utils.addressToBytes32(router.address);
      // Does not revert.
      await inbox.testHandle(origin, remote, recipient, message);
    });

    it('rejects message from unenrolled inbox', async () => {
      await expect(
        router.handle(
          origin,
          utils.addressToBytes32(nonOwner.address),
          message,
        ),
      ).to.be.revertedWith('!inbox');
    });

    it('rejects message from unenrolled router', async () => {
      await connectionManager.enrollInbox(origin, inbox.address);
      const recipient = utils.addressToBytes32(router.address);
      const sender = utils.addressToBytes32(nonOwner.address);
      await expect(
        inbox.testHandle(origin, sender, recipient, message),
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

    it('non-owner cannot enroll remote router', async () => {
      await expect(
        router
          .connect(nonOwner)
          .enrollRemoteRouter(origin, utils.addressToBytes32(nonOwner.address)),
      ).to.be.revertedWith(ONLY_OWNER_REVERT_MSG);
    });

    describe('dispatch functions', () => {
      let interchainGasPaymaster: InterchainGasPaymaster;
      beforeEach(async () => {
        const interchainGasPaymasterFactory =
          new InterchainGasPaymaster__factory(signer);
        interchainGasPaymaster = await interchainGasPaymasterFactory.deploy();
        await router.setInterchainGasPaymaster(interchainGasPaymaster.address);

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
          interchainGasPayment?: number,
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

        it('dispatches a message', async () => {
          await expect(dispatchFunction(destination)).to.emit(
            outbox,
            'Dispatch',
          );
        });

        it(`${
          expectGasPayment ? 'pays' : 'does not pay'
        } interchain gas`, async () => {
          const testInterchainGasPayment = 1234;
          const leafIndex = await outbox.count();
          const assertion = expectAssertion(
            expect(dispatchFunction(destination, testInterchainGasPayment)).to,
            expectGasPayment,
          );
          await assertion
            .emit(interchainGasPaymaster, 'GasPayment')
            .withArgs(outbox.address, leafIndex, testInterchainGasPayment);
        });

        it('reverts when dispatching a message to an unenrolled remote router', async () => {
          await expect(
            dispatchFunction(destinationWithoutRouter),
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
          (destinationDomain, interchainGasPayment = 0) =>
            router.dispatchWithGas(
              destinationDomain,
              '0x',
              interchainGasPayment,
              {
                value: interchainGasPayment,
              },
            ),
          true,
        );
      });
    });
  });
});
