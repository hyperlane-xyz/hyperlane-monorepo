import { ethers, abacus } from 'hardhat';
import { expect } from 'chai';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';

import { YoDeploy } from './YoDeploy';
import { Yo } from '../src/types';

const localDomain = 1000;
const remoteDomain = 2000;
const domains = [localDomain, remoteDomain];

describe('Yo', async () => {
  let signer: SignerWithAddress, router: Yo, remote: Yo, yo: YoDeploy;

  before(async () => {
    [signer] = await ethers.getSigners();
    await abacus.deploy(domains, signer);
  });

  beforeEach(async () => {
    const config = { signer };
    yo = new YoDeploy(config);
    await yo.deploy(abacus);
    router = yo.router(localDomain);
    remote = yo.router(remoteDomain);
    expect(await router.sent()).to.equal(0);
    expect(await router.received()).to.equal(0);
    expect(await remote.sent()).to.equal(0);
    expect(await remote.received()).to.equal(0);
  });

  it('sends an initial yo', async () => {
    await expect(router.yoRemote(remoteDomain)).to.emit(
      abacus.outbox(localDomain),
      'Dispatch',
    );
    expect(await router.sent()).to.equal(1);
    expect(await router.sentTo(remoteDomain)).to.equal(1);
    expect(await router.received()).to.equal(0);
  });

  it('handles a yo', async () => {
    await router.yoRemote(remoteDomain);
    // Processing the initial yo causes a pong to be dispatched from the remote domain.
    await abacus.processOutboundMessages(localDomain);
    // The initial yo has been dispatched.
    expect(await router.sent()).to.equal(1);
    // The initial yo has been processed.
    expect(await remote.received()).to.equal(1);
    expect(await remote.receivedFrom(localDomain)).to.equal(1);
  });
});
