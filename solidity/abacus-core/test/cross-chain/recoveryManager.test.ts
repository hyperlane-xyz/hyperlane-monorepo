import { ethers, abacus } from 'hardhat';
import { expect } from 'chai';
import * as types from 'ethers';

import { formatCall, sendFromSigner } from './utils';
import { increaseTimestampBy } from '../utils';
import { Validator } from '../lib/core';
import { Signer } from '../lib/types';
import {
  ValidatorManager,
  TestGovernanceRouter,
  TestHome,
} from '../../typechain';
import { AbacusDeployment } from '../lib/AbacusDeployment';
import { GovernanceDeployment } from '../lib/GovernanceDeployment';

async function expectNotInRecovery(
  validatorManager: ValidatorManager,
  recoveryManager: types.Signer,
  randomSigner: Signer,
  governor: Signer,
  governanceRouter: TestGovernanceRouter,
  home: TestHome,
) {
  expect(await governanceRouter.inRecovery()).to.be.false;

  // Format abacus call message
  const call = await formatCall(validatorManager, 'setValidator', [
    1000,
    randomSigner.address,
  ]);

  // Expect that Governor *CAN* Call Local & Call Remote
  // dispatch call on local governorRouter
  await expect(
    sendFromSigner(governor, governanceRouter, 'callLocal', [[call]]),
  )
    .to.emit(validatorManager, 'NewValidator')
    .withArgs(1000, randomSigner.address);

  // dispatch call on local governorRouter
  await expect(
    sendFromSigner(governor, governanceRouter, 'callRemote', [2000, [call]]),
  ).to.emit(home, 'Dispatch');

  // set xApp Connection Manager
  const xAppConnectionManager = await governanceRouter.xAppConnectionManager();
  await expect(
    sendFromSigner(governor, governanceRouter, 'setXAppConnectionManager', [
      randomSigner.address,
    ]),
  ).to.not.be.reverted;
  // reset xApp Connection Manager to actual contract
  await sendFromSigner(governor, governanceRouter, 'setXAppConnectionManager', [
    xAppConnectionManager,
  ]);

  // set Router Locally
  const otherDomain = 2000;
  const previousRouter = await governanceRouter.routers(otherDomain);
  await expect(
    sendFromSigner(governor, governanceRouter, 'setRouterLocal', [
      2000,
      abacus.ethersAddressToBytes32(randomSigner.address),
    ]),
  )
    .to.emit(governanceRouter, 'SetRouter')
    .withArgs(
      otherDomain,
      previousRouter,
      abacus.ethersAddressToBytes32(randomSigner.address),
    );

  // Expect that Recovery Manager CANNOT Call Local OR Call Remote
  // cannot dispatch call on local governorRouter
  await expect(
    sendFromSigner(recoveryManager, governanceRouter, 'callLocal', [[call]]),
  ).to.be.revertedWith('! called by governor');

  // cannot dispatch call to remote governorRouter
  await expect(
    sendFromSigner(recoveryManager, governanceRouter, 'callRemote', [
      2000,
      [call],
    ]),
  ).to.be.revertedWith('! called by governor');

  // cannot set xAppConnectionManager
  await expect(
    sendFromSigner(
      recoveryManager,
      governanceRouter,
      'setXAppConnectionManager',
      [randomSigner.address],
    ),
  ).to.be.revertedWith('! called by governor');

  // cannot set Router
  await expect(
    sendFromSigner(recoveryManager, governanceRouter, 'setRouterLocal', [
      2000,
      abacus.ethersAddressToBytes32(randomSigner.address),
    ]),
  ).to.be.revertedWith('! called by governor');
}

async function expectOnlyRecoveryManagerCanTransferRole(
  governor: Signer,
  governanceRouter: TestGovernanceRouter,
  randomSigner: Signer,
  recoveryManager: Signer,
) {
  await expect(
    sendFromSigner(governor, governanceRouter, 'transferRecoveryManager', [
      randomSigner.address,
    ]),
  ).to.be.revertedWith('! called by recovery manager');

  await expect(
    sendFromSigner(randomSigner, governanceRouter, 'transferRecoveryManager', [
      randomSigner.address,
    ]),
  ).to.be.revertedWith('! called by recovery manager');

  await expect(
    sendFromSigner(
      recoveryManager,
      governanceRouter,
      'transferRecoveryManager',
      [randomSigner.address],
    ),
  )
    .to.emit(governanceRouter, 'TransferRecoveryManager')
    .withArgs(recoveryManager.address, randomSigner.address);

  await expect(
    sendFromSigner(randomSigner, governanceRouter, 'transferRecoveryManager', [
      recoveryManager.address,
    ]),
  )
    .to.emit(governanceRouter, 'TransferRecoveryManager')
    .withArgs(randomSigner.address, recoveryManager.address);
}

async function expectOnlyRecoveryManagerCanExitRecovery(
  governor: Signer,
  governanceRouter: TestGovernanceRouter,
  randomSigner: Signer,
  recoveryManager: Signer,
) {
  await expect(
    sendFromSigner(governor, governanceRouter, 'exitRecovery', []),
  ).to.be.revertedWith('! called by recovery manager');

  await expect(
    sendFromSigner(randomSigner, governanceRouter, 'exitRecovery', []),
  ).to.be.revertedWith('! called by recovery manager');

  await expect(
    sendFromSigner(recoveryManager, governanceRouter, 'exitRecovery', []),
  )
    .to.emit(governanceRouter, 'ExitRecovery')
    .withArgs(recoveryManager.address);
}

async function expectOnlyRecoveryManagerCanInitiateRecovery(
  governor: Signer,
  governanceRouter: TestGovernanceRouter,
  randomSigner: Signer,
  recoveryManager: Signer,
) {
  await expect(
    sendFromSigner(governor, governanceRouter, 'initiateRecoveryTimelock', []),
  ).to.be.revertedWith('! called by recovery manager');

  await expect(
    sendFromSigner(
      randomSigner,
      governanceRouter,
      'initiateRecoveryTimelock',
      [],
    ),
  ).to.be.revertedWith('! called by recovery manager');

  expect(await governanceRouter.recoveryActiveAt()).to.equal(0);

  await expect(
    sendFromSigner(
      recoveryManager,
      governanceRouter,
      'initiateRecoveryTimelock',
      [],
    ),
  ).to.emit(governanceRouter, 'InitiateRecovery');

  expect(await governanceRouter.recoveryActiveAt()).to.not.equal(0);
}

const localDomain = 1000;
const remoteDomain = 2000;
const domains = [localDomain, remoteDomain];

/*
 * Deploy the full Abacus suite on two chains
 */
describe('RecoveryManager', async () => {
  let abacusDeployment: AbacusDeployment;
  let governanceDeployment: GovernanceDeployment;
  let governor: Signer,
    recoveryManager: Signer,
    randomSigner: Signer,
    governanceRouter: TestGovernanceRouter,
    home: TestHome,
    validatorManager: ValidatorManager;

  before(async () => {
    [governor, recoveryManager, randomSigner] = await ethers.getSigners();
    const validator = await Validator.fromSigner(randomSigner, localDomain);
    abacusDeployment = await abacus.deployment.fromDomains(
      domains,
      randomSigner,
    );
    governanceDeployment = await GovernanceDeployment.fromAbacusDeployment(
      abacusDeployment,
      recoveryManager,
    );
    for (const domain of domains) {
      await abacusDeployment.transferOwnership(
        domain,
        governanceDeployment.router(domain).address,
      );
    }

    governanceRouter = governanceDeployment.router(localDomain);
    home = abacusDeployment.home(localDomain);
    validatorManager = abacusDeployment.validatorManager(localDomain);

    // set governor
    await governanceRouter.transferGovernor(localDomain, governor.address);
  });

  it('Before Recovery Initiated: Timelock has not been set', async () => {
    expect(await governanceRouter.recoveryActiveAt()).to.equal(0);
  });

  it('Before Recovery Initiated: Cannot Exit Recovery yet', async () => {
    await expect(
      sendFromSigner(recoveryManager, governanceRouter, 'exitRecovery', []),
    ).to.be.revertedWith('recovery not initiated');
  });

  it('Before Recovery Initiated: Not in Recovery (Governor CAN Call Local & Remote; Recovery Manager CANNOT Call either)', async () => {
    await expectNotInRecovery(
      validatorManager,
      recoveryManager,
      randomSigner,
      governor,
      governanceRouter,
      home,
    );
  });

  it('Before Recovery Initiated: ONLY RecoveryManager can transfer RecoveryManager role', async () => {
    await expectOnlyRecoveryManagerCanTransferRole(
      governor,
      governanceRouter,
      randomSigner,
      recoveryManager,
    );
  });

  it('Before Recovery Initiated: ONLY RecoveryManager can Initiate Recovery', async () => {
    await expectOnlyRecoveryManagerCanInitiateRecovery(
      governor,
      governanceRouter,
      randomSigner,
      recoveryManager,
    );
  });

  it('Before Recovery Active: CANNOT Initiate Recovery Twice', async () => {
    await expect(
      sendFromSigner(
        recoveryManager,
        governanceRouter,
        'initiateRecoveryTimelock',
        [],
      ),
    ).to.be.revertedWith('recovery already initiated');
  });

  it('Before Recovery Active: Not in Recovery (Governor CAN Call Local & Remote; Recovery Manager CANNOT Call either)', async () => {
    await expectNotInRecovery(
      validatorManager,
      recoveryManager,
      randomSigner,
      governor,
      governanceRouter,
      home,
    );
  });

  it('Before Recovery Active: ONLY RecoveryManager can transfer RecoveryManager role', async () => {
    await expectOnlyRecoveryManagerCanTransferRole(
      governor,
      governanceRouter,
      randomSigner,
      recoveryManager,
    );
  });

  it('Before Recovery Active: ONLY RecoveryManager can Exit Recovery', async () => {
    await expectOnlyRecoveryManagerCanExitRecovery(
      governor,
      governanceRouter,
      randomSigner,
      recoveryManager,
    );
  });

  it('Before Recovery Active: ONLY RecoveryManager can Initiate Recovery (CAN initiate a second time)', async () => {
    await expectOnlyRecoveryManagerCanInitiateRecovery(
      governor,
      governanceRouter,
      randomSigner,
      recoveryManager,
    );
  });

  it('Recovery Active: inRecovery becomes true when timelock expires', async () => {
    // increase timestamp on-chain
    const timelock = await governanceRouter.recoveryTimelock();
    await increaseTimestampBy(ethers.provider, timelock.toNumber());
    expect(await governanceRouter.inRecovery()).to.be.true;
  });

  it('Recovery Active: RecoveryManager CAN call local', async () => {
    // Format abacus call message
    const call = await formatCall(validatorManager, 'setValidator', [
      localDomain,
      randomSigner.address,
    ]);

    // dispatch call on local governorRouter
    await expect(
      sendFromSigner(recoveryManager, governanceRouter, 'callLocal', [[call]]),
    )
      .to.emit(validatorManager, 'NewValidator')
      .withArgs(localDomain, randomSigner.address);
  });

  it('Recovery Active: RecoveryManager CANNOT call remote', async () => {
    // Format abacus call message
    const call = await formatCall(validatorManager, 'setValidator', [
      localDomain,
      randomSigner.address,
    ]);

    // dispatch call on local governorRouter
    await expect(
      sendFromSigner(recoveryManager, governanceRouter, 'callRemote', [
        2000,
        [call],
      ]),
    ).to.be.revertedWith('! called by governor');
  });

  it('Recovery Active: RecoveryManager CAN set xAppConnectionManager', async () => {
    // set xApp Connection Manager
    const xAppConnectionManager =
      await governanceRouter.xAppConnectionManager();
    await expect(
      sendFromSigner(
        recoveryManager,
        governanceRouter,
        'setXAppConnectionManager',
        [randomSigner.address],
      ),
    ).to.not.be.reverted;
    // reset xApp Connection Manager to actual contract
    await sendFromSigner(
      recoveryManager,
      governanceRouter,
      'setXAppConnectionManager',
      [xAppConnectionManager],
    );
  });

  it('Recovery Active: RecoveryManager CAN set Router locally', async () => {
    const otherDomain = 2000;
    const previousRouter = await governanceRouter.routers(otherDomain);
    await expect(
      sendFromSigner(recoveryManager, governanceRouter, 'setRouterLocal', [
        2000,
        abacus.ethersAddressToBytes32(randomSigner.address),
      ]),
    )
      .to.emit(governanceRouter, 'SetRouter')
      .withArgs(
        otherDomain,
        previousRouter,
        abacus.ethersAddressToBytes32(randomSigner.address),
      );
  });

  it('Recovery Active: Governor CANNOT call local OR remote', async () => {
    // Format abacus call message
    const call = await formatCall(validatorManager, 'setValidator', [
      localDomain,
      randomSigner.address,
    ]);

    // dispatch call on local governorRouter
    await expect(
      sendFromSigner(governor, governanceRouter, 'callLocal', [[call]]),
    ).to.be.revertedWith('! called by recovery manager');

    // dispatch call on local governorRouter
    await expect(
      sendFromSigner(governor, governanceRouter, 'callRemote', [2000, [call]]),
    ).to.be.revertedWith('in recovery');
  });

  it('Recovery Active: Governor CANNOT set xAppConnectionManager', async () => {
    // cannot set xAppConnectionManager
    await expect(
      sendFromSigner(governor, governanceRouter, 'setXAppConnectionManager', [
        randomSigner.address,
      ]),
    ).to.be.revertedWith('! called by recovery manager');
  });

  it('Recovery Active: Governor CANNOT set Router locally', async () => {
    // cannot set Router
    await expect(
      sendFromSigner(governor, governanceRouter, 'setRouterLocal', [
        2000,
        abacus.ethersAddressToBytes32(randomSigner.address),
      ]),
    ).to.be.revertedWith('! called by recovery manager');
  });

  it('Recovery Active: ONLY RecoveryManager can transfer RecoveryManager role', async () => {
    await expectOnlyRecoveryManagerCanTransferRole(
      governor,
      governanceRouter,
      randomSigner,
      recoveryManager,
    );
  });

  it('Recovery Active: ONLY RecoveryManager can Exit Recovery', async () => {
    await expectOnlyRecoveryManagerCanExitRecovery(
      governor,
      governanceRouter,
      randomSigner,
      recoveryManager,
    );
  });

  it('Exited Recovery: Timelock is deleted', async () => {
    expect(await governanceRouter.recoveryActiveAt()).to.equal(0);
  });

  it('Exited Recovery: Not in Recovery (Governor CAN Call Local & Remote; Recovery Manager CANNOT Call either)', async () => {
    await expectNotInRecovery(
      validatorManager,
      recoveryManager,
      randomSigner,
      governor,
      governanceRouter,
      home,
    );
  });

  it('Exited Recovery: ONLY RecoveryManager can transfer RecoveryManager role', async () => {
    await expectOnlyRecoveryManagerCanTransferRole(
      governor,
      governanceRouter,
      randomSigner,
      recoveryManager,
    );
  });
});
