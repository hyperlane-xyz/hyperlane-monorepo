import { expect } from 'chai';
import sinon from 'sinon';

import { DEFAULT_GITHUB_REGISTRY } from '@hyperlane-xyz/registry';

import {
  CentralizedWarpRouteMonitorHelmManager,
  registryUriFromCommit,
} from '../src/warp-monitor/helm.js';

describe('centralized warp monitor Explorer settings', () => {
  it('preserves the Explorer URL on upgrade and leaves it empty on install', async () => {
    const manager = new CentralizedWarpRouteMonitorHelmManager(
      'test',
      [],
      'main',
      [],
      'new-image',
    );
    const deployed = sinon.stub(manager, 'getDeployedHelmValues');
    for (const explorerApiUrl of ['', 'https://custom.example/graphql']) {
      deployed.resolves({ centralized: { explorerApiUrl } });
      expect((await manager.helmValues()).centralized.explorerApiUrl).to.equal(
        explorerApiUrl,
      );
    }
    deployed.resolves(null);
    expect((await manager.helmValues()).centralized.explorerApiUrl).to.equal(
      '',
    );
  });
});

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
