import { expect } from 'chai';

import {
  getTollkeeperDeploymentNames,
  getTollkeeperReleaseConfigs,
} from '../src/tollkeeper/releases.js';

describe('Tollkeeper Helm integration', () => {
  it('maps the mainnet3 environment to the dedicated production namespace', () => {
    expect(getTollkeeperReleaseConfigs('mainnet3')).to.deep.equal([
      { releaseName: 'tollkeeper-prod', namespace: 'tollkeeper' },
    ]);
  });

  it('does not invent Tollkeeper releases for other environments', () => {
    expect(getTollkeeperReleaseConfigs('testnet4')).to.deep.equal([]);
  });

  it('restarts both RPC consumers after secret rotation', () => {
    expect(getTollkeeperDeploymentNames('tollkeeper-prod')).to.deep.equal([
      'tollkeeper-prod',
      'tollkeeper-prod-signer',
    ]);
  });
});
