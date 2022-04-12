import { ethers, abacus } from 'hardhat';
import { expect } from 'chai';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';

import { PingPongDeploy } from './PingPongDeploy';
import { PingPong } from '../src/types';

const localDomain = 1000;
const remoteDomain = 2000;
const domains = [localDomain, remoteDomain];

describe('PingPong', async () => {
  let signer: SignerWithAddress,
    router: PingPong,
    remote: PingPong,
    pingPong: PingPongDeploy;

  before(async () => {
    [signer] = await ethers.getSigners();
    await abacus.deploy(domains, signer);
  });

  beforeEach(async () => {
    const config = { signer };
    pingPong = new PingPongDeploy(config);
    await pingPong.deploy(abacus);
    router = pingPong.router(localDomain);
    remote = pingPong.router(remoteDomain);
    expect(await router.sent()).to.equal(0);
    expect(await router.received()).to.equal(0);
    expect(await remote.sent()).to.equal(0);
    expect(await remote.received()).to.equal(0);
  });

  it('sends an initial ping', async () => {
    await expect(router.pingRemote(remoteDomain)).to.emit(
      abacus.outbox(localDomain),
      'Dispatch',
    );
    expect(await router.sent()).to.equal(1);
    expect(await router.received()).to.equal(0);
  });

  it('responds to a ping with a pong', async () => {
    await router.pingRemote(remoteDomain);
    // Processing the initial ping causes a pong to be dispatched from the remote domain.
    await abacus.processOutboundMessages(localDomain);
    // The initial ping has been dispatched.
    expect(await router.sent()).to.equal(1);
    // The pong has been dispatched but not processed..
    expect(await router.received()).to.equal(0);
    // The pong has been dispatched.
    expect(await remote.sent()).to.equal(1);
    // The initial ping has been processed.
    expect(await remote.received()).to.equal(1);
  });

  it('responds to a pong with a ping', async () => {
    await router.pingRemote(remoteDomain);
    // Processing the initial ping causes a pong to be dispatched from the remote domain.
    await abacus.processOutboundMessages(localDomain);
    // Processing the pong response causes a ping to be dispatched from the local domain.
    await abacus.processOutboundMessages(remoteDomain);
    // The initial ping and the response to the pong.
    expect(await router.sent()).to.equal(2);
    // The pong.
    expect(await router.received()).to.equal(1);
    // The pong has been dispatched.
    expect(await remote.sent()).to.equal(1);
    // The initial ping has been processed.
    expect(await remote.received()).to.equal(1);
  });
});
