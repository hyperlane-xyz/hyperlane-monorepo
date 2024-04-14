import { expect } from 'chai';

import { objLength } from '@hyperlane-xyz/utils';

import { GithubRegistry } from './GithubRegistry.js';

describe('GithubRegistry', () => {
  let registry: GithubRegistry;

  it('Constructs and parses URL', async () => {
    registry = new GithubRegistry();
    expect(registry.repoOwner).to.eql('hyperlane-xyz');
    expect(registry.repoName).to.eql('hyperlane-registry');
    expect(registry.branch).to.eql('main');
  });

  it('Fetches all chain metadata', async () => {
    const metadata = await registry.getMetadata();
    expect(objLength(metadata)).to.be.greaterThan(0);
    expect(metadata['ethereum'].chainId).to.eql(1);
  }).timeout(10_000);

  it('Fetches single chain metadata', async () => {
    const metadata = await registry.getChainMetadata('ethereum');
    expect(metadata.chainId).to.eql(1);
  }).timeout(5_000);

  it('Fetches chain addresses', async () => {
    const addresses = await registry.getAddresses();
    expect(objLength(addresses)).to.be.greaterThan(0);
    expect(addresses['ethereum'].mailbox.substring(0, 2)).to.eql('0x');
  }).timeout(10_000);

  it('Fetches single chain addresses', async () => {
    const addresses = await registry.getChainAddresses('ethereum');
    expect(addresses.mailbox.substring(0, 2)).to.eql('0x');
  }).timeout(5_000);
});
