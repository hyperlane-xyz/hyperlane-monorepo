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
} from '@abacus-network/core';
import { utils } from '@abacus-network/utils';

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
    const remote = utils.addressToBytes32(nonOwner.address);
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
      router
        .connect(nonOwner)
        .enrollRemoteRouter(origin, utils.addressToBytes32(nonOwner.address)),
    ).to.be.revertedWith(ONLY_OWNER_REVERT_MSG);
  });

  describe('dispatch functions', () => {
    let interchainGasPaymaster: InterchainGasPaymaster;
    beforeEach(async () => {
      const interchainGasPaymasterFactory = new InterchainGasPaymaster__factory(
        signer,
      );
      interchainGasPaymaster = await interchainGasPaymasterFactory.deploy();
      await connectionManager.setInterchainGasPaymaster(
        interchainGasPaymaster.address,
      );

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
      expectCheckpoint: boolean,
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
        await expect(dispatchFunction(destination)).to.emit(outbox, 'Dispatch');
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
          .withArgs(leafIndex, testInterchainGasPayment);
      });

      it(`${
        expectCheckpoint ? 'creates' : 'does not create'
      } a checkpoint`, async () => {
        const assertion = expectAssertion(
          expect(dispatchFunction(destination)).to,
          expectCheckpoint,
        );
        await assertion.emit(outbox, 'Checkpoint');
      });

      it('reverts when dispatching a message to an unenrolled remote router', async () => {
        await expect(
          dispatchFunction(destinationWithoutRouter),
        ).to.be.revertedWith('!router');
      });
    };

    describe('#dispatch', () => {
      runDispatchFunctionTests(
        (destinationDomain) => router.dispatch(destinationDomain, '0x'),
        false,
        false,
      );
    });

    describe('#dispatchAndCheckpoint', () => {
      runDispatchFunctionTests(
        (destinationDomain) =>
          router.dispatchAndCheckpoint(destinationDomain, '0x'),
        true,
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
        false,
        true,
      );
    });

    describe('#dispatchWithGasAndCheckpoint', () => {
      runDispatchFunctionTests(
        (destinationDomain, interchainGasPayment = 0) =>
          router.dispatchWithGasAndCheckpoint(
            destinationDomain,
            '0x',
            interchainGasPayment,
            { value: interchainGasPayment },
          ),
        true,
        true,
      );
    });
  });

  describe('#checkpoint', () => {
    it('creates a checkpoint', async () => {
      // dispatch dummy message
      await outbox.dispatch(
        destination,
        utils.addressToBytes32(outbox.address),
        '0x',
      );
      await expect(router.checkpoint()).to.emit(outbox, 'Checkpoint');
    });
  });
});
