import { ethers, abacus } from 'hardhat';
import { expect } from 'chai';

import { AbacusState, Updater } from './lib/core';
import { Signer } from './lib/types';

import { Home__factory, Home, UpdaterManager__factory, UpdaterManager } from '../typechain';

const homeDomainHashCases = require('../../../vectors/homeDomainHash.json');
const signedUpdateCases = require('../../../vectors/signedUpdate.json');
const localDomain = 1000;

describe('UpdaterManager', async () => {
  let signer: Signer,
    fakeSigner: Signer,
    updaterManager: UpdaterManager,
    updater: Updater,
    fakeUpdater: Updater;

  before(async () => {
    [signer, fakeSigner] = await ethers.getSigners();
    updater = await Updater.fromSigner(signer, localDomain);
    fakeUpdater = await Updater.fromSigner(fakeSigner, localDomain);
  });

  beforeEach(async () => {
    const updaterManagerFactory = new UpdaterManager__factory(signer);
    updaterManager = await updaterManagerFactory.deploy();
  });

  it('Accepts updater signature', async () => {
    const root = ethers.utils.formatBytes32String('root');
    const index = 1;

    const { signature } = await updater.signCheckpoint(root, index);
    const isValid = await updaterManager.isUpdaterSignature(
      localDomain,
      root,
      index,
      signature,
    );
    expect(isValid).to.be.true;
  });

  it('Rejects non-updater signature', async () => {
    const root = ethers.utils.formatBytes32String('root');
    const index = 1;

    const { signature } = await fakeUpdater.signCheckpoint(root, index);
    const isValid = await updaterManager.isUpdaterSignature(
      localDomain,
      root,
      index,
      signature,
    );
    expect(isValid)
      .to.be.false;
  });

  it('Calculated domain hash matches Rust-produced domain hash', async () => {
    // Compare Rust output in json file to solidity output (json file matches
    // hash for local domain of 1000)
    for (let testCase of homeDomainHashCases) {
      const { expectedDomainHash } = testCase;
      const domainHash = await updaterManager.domainHash(testCase.homeDomain);
      expect(domainHash).to.equal(expectedDomainHash);
    }
  });

  describe('improper updates', async () => {
    let home: Home;
    beforeEach(async () => {
      const homeFactory = new Home__factory(signer);
      home = await homeFactory.deploy(localDomain);
      await home.initialize(updaterManager.address);
    });

    it('Accepts improper update from updater', async () => {
      const root = ethers.utils.formatBytes32String('root');
      const index = 1;

      const { signature } = await updater.signCheckpoint(root, index);
      // Send message with signer address as msg.sender
      await expect(
        updaterManager.improperUpdate(home.address, root, index, signature)
      )
        .to.emit(updaterManager, 'ImproperUpdate')
        .withArgs(
          home.address, localDomain, updater.address, root, index, signature);
      expect(await home.state()).to.equal(AbacusState.FAILED);
    });

    it('Rejects improper update from non-updater', async () => {
      const root = ethers.utils.formatBytes32String('root');
      const index = 1;

      const { signature } = await fakeUpdater.signCheckpoint(root, index);
      // Send message with signer address as msg.sender
      await expect(
        updaterManager.improperUpdate(home.address, root, index, signature)
    ).to.be.revertedWith('!updater sig');
    });

    it('Rejects proper update from updater', async () => {
      const message = `0x${Buffer.alloc(10).toString('hex')}`;
      await home
          .dispatch(
            localDomain,
            abacus.ethersAddressToBytes32(signer.address),
            message,
          );
        await  home.checkpoint()
      const [root, index] = await home.latestCheckpoint();

      const { signature } = await updater.signCheckpoint(root, index.toNumber());
      // Send message with signer address as msg.sender
      await expect(
        updaterManager.improperUpdate(home.address, root, index, signature)
    ).to.be.revertedWith('!improper');
    });
  });
});
