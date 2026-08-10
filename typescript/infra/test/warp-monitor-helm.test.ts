import { expect } from 'chai';

import { DEFAULT_GITHUB_REGISTRY } from '@hyperlane-xyz/registry';

import { registryUriFromCommit } from '../src/warp-monitor/helm.js';

describe('registryUriFromCommit', () => {
  it('embeds the commit in /tree/{commit} form', () => {
    expect(registryUriFromCommit('abc123')).to.equal(
      `${DEFAULT_GITHUB_REGISTRY}/tree/abc123`,
    );
  });

  it('falls back to the default registry when no commit is given', () => {
    expect(registryUriFromCommit('')).to.equal(DEFAULT_GITHUB_REGISTRY);
  });
});
