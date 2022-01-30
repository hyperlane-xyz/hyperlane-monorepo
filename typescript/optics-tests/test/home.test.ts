import { ethers, optics } from 'hardhat';
import { expect } from 'chai';
import { getTestDeploy } from './testChain';
import { OpticsState, Updater } from '../lib/core';
import { Signer } from '../lib/types';
import { CoreDeploy as Deploy } from 'optics-deploy/dist/src/core/CoreDeploy';
import * as deploys from 'optics-deploy/dist/src/core';

import {
  TestHome,
  UpdaterManager__factory,
  UpdaterManager,
} from 'optics-ts-interface/dist/optics-core';

const homeDomainHashTestCases = require('../../../vectors/homeDomainHash.json');
const destinationNonceTestCases = require('../../../vectors/destinationNonce.json');

const localDomain = 1000;
const destDomain = 2000;
const emptyAddress: string = '0x' + '00'.repeat(32);

describe('Home', async () => {
  let deploy: Deploy,
    home: TestHome,
    signer: Signer,
    fakeSigner: Signer,
    recipient: Signer,
    updater: Updater,
    fakeUpdater: Updater,
    fakeUpdaterManager: UpdaterManager;

  // Helper function that dispatches message and returns intermediate root.
  // The message recipient is the same for all messages dispatched.
  const dispatchMessageAndGetRoot = async (message: string) => {
    message = ethers.utils.formatBytes32String(message);
    await home.dispatch(
      destDomain,
      optics.ethersAddressToBytes32(recipient.address),
      message,
    );
    return home.currentRoot()
  };

  before(async () => {
    [signer, fakeSigner, recipient] = await ethers.getSigners();
    updater = await Updater.fromSigner(signer, localDomain);

    deploy = await getTestDeploy(localDomain, updater.address, []);

    await deploys.deployUpdaterManager(deploy);
    await deploys.deployUpgradeBeaconController(deploy);

    fakeUpdater = await Updater.fromSigner(fakeSigner, localDomain);

    // deploy fake UpdaterManager
    const updaterManagerFactory = new UpdaterManager__factory(signer);
    fakeUpdaterManager = await updaterManagerFactory.deploy(updater.address);

    const ret = await fakeUpdaterManager.updater();
    expect(ret).to.equal(signer.address);
  });

  beforeEach(async () => {
    // redeploy the home before each test run
    await deploys.deployHome(deploy);
    home = deploy.contracts.home?.proxy as TestHome;

    // set home on UpdaterManager
    await deploy.contracts.updaterManager!.setHome(home.address);
  });

  it('Cannot be initialized twice', async () => {
    await expect(
      home.initialize(fakeUpdaterManager.address),
    ).to.be.revertedWith('Initializable: contract is already initialized');
  });

  it('Halts on fail', async () => {
    await home.setFailed();
    expect(await home.state()).to.equal(OpticsState.FAILED);

    const message = ethers.utils.formatBytes32String('message');
    await expect(
      home.dispatch(
        destDomain,
        optics.ethersAddressToBytes32(recipient.address),
        message,
      ),
    ).to.be.revertedWith('failed state');
  });

  it('Calculated domain hash matches Rust-produced domain hash', async () => {
    // Compare Rust output in json file to solidity output (json file matches
    // hash for local domain of 1000)
    for (let testCase of homeDomainHashTestCases) {
      let deploy = await getTestDeploy(
        testCase.homeDomain,
        fakeUpdaterManager.address,
        [],
      );
      await deploys.deployUpdaterManager(deploy);
      await deploys.deployUpgradeBeaconController(deploy);
      await deploys.deployHome(deploy);

      const tempHome = deploy.contracts.home?.proxy! as TestHome;
      const { expectedDomainHash } = testCase;
      const homeDomainHash = await tempHome.testHomeDomainHash();
      expect(homeDomainHash).to.equal(expectedDomainHash);
    }
  });

  it('Does not dispatch too large messages', async () => {
    const message = `0x${Buffer.alloc(3000).toString('hex')}`;
    await expect(
      home
        .connect(signer)
        .dispatch(
          destDomain,
          optics.ethersAddressToBytes32(recipient.address),
          message,
        ),
    ).to.be.revertedWith('msg too long');
  });

  it('Dispatches a message', async () => {
    const message = ethers.utils.formatBytes32String('message');
    const nonce = await home.nonces(localDomain);

    // Format data that will be emitted from Dispatch event
    const destinationAndNonce = optics.destinationAndNonce(destDomain, nonce);

    const opticsMessage = optics.formatMessage(
      localDomain,
      signer.address,
      nonce,
      destDomain,
      recipient.address,
      message,
    );
    const messageHash = optics.messageHash(opticsMessage);
    const leafIndex = await home.nextLeafIndex();
    const committedRoot = await home.committedRoot();

    // Send message with signer address as msg.sender
    await expect(
      home
        .connect(signer)
        .dispatch(
          destDomain,
          optics.ethersAddressToBytes32(recipient.address),
          message,
        ),
    )
      .to.emit(home, 'Dispatch')
      .withArgs(
        messageHash,
        leafIndex,
        destinationAndNonce,
        committedRoot,
        opticsMessage,
      );
  });

  it('Does not allow commitment to empty tree', async () => {
    const [root, index] = await home.currentCommitment();
    expect(root).to.equal(emptyAddress);
    expect(index).to.equal(emptyAddress);

    await expect(home.commit()).to.be.revertedWith('!count');
  });


  it('Updates root and index after commitment', async () => {
    const message = ethers.utils.formatBytes32String('message');
    await home.dispatch(
      destDomain,
      optics.ethersAddressToBytes32(recipient.address),
      message,
    );
    const currentRoot = await home.currentRoot()
    const currentIndex = await home.currentIndex()
    await home.commit()

    const [root, index] = await home.currentCommitment();
    expect(root).to.equal(currentRoot);
    expect(index).to.equal(currentIndex);
  });

  it('Batch commits several messages', async () => {
    await dispatchMessageAndGetRoot('message1');
    await dispatchMessageAndGetRoot('message2');
    const currentRoot = await dispatchMessageAndGetRoot('message3');

    await expect(home.commit()).to.emit(home, 'Commit').withArgs(currentRoot, 2);
    const [committedRoot, committedIndex] = await home.currentCommitment();
    expect(committedRoot).to.equal(currentRoot);
    expect(committedIndex).to.equal(2);
  });

  // This may not fail because currentIndex may be zero
  it('Fails on valid improper update', async () => {
    const root = ethers.utils.formatBytes32String('root');
    const index = ethers.BigNumber.from(1)
    const { signature } = await updater.signUpdate(root, index);

    await expect(
      home.improperUpdate(root, index, signature)
    ).to.emit(home, 'ImproperUpdate');
    expect(await home.state()).to.equal(OpticsState.FAILED);
  });

  it('Does not fail on improper update signed by non-updater', async () => {
    const root = ethers.utils.formatBytes32String('root');
    const index = ethers.BigNumber.from(1)
    const { signature } = await fakeUpdater.signUpdate(root, index);

    await expect(
      home.improperUpdate(root, index, signature)
    ).to.be.revertedWith('!updater sig');
  });

  it('Does not fail on improper updates with zero index', async () => {
    const root = ethers.utils.formatBytes32String('root');
    const index = ethers.BigNumber.from(0)
    const { signature } = await updater.signUpdate(root, index);

    await expect(
      home.improperUpdate(root, index, signature)
    ).to.be.revertedWith('!improper');
  })

  it('Does not fail on valid updates', async () => {
    await dispatchMessageAndGetRoot('message');
    await dispatchMessageAndGetRoot('message2');
    await home.commit();
    const [root, index ] = await home.currentCommitment()
    const { signature } = await updater.signUpdate(root, index);

    await expect(
      home.improperUpdate(root, index, signature)
    ).to.be.revertedWith('!improper');
  });

  it('Correctly calculates destinationAndNonce', async () => {
    for (let testCase of destinationNonceTestCases) {
      let { destination, nonce, expectedDestinationAndNonce } = testCase;
      const solidityDestinationAndNonce = await home.testDestinationAndNonce(
        destination,
        nonce,
      );
      expect(solidityDestinationAndNonce).to.equal(expectedDestinationAndNonce);
    }
  });
});
