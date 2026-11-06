import { expect } from 'chai';

import {
  IcaRouterVersion,
  selectIcaRouterAddresses,
} from '../scripts/check/ica-router-version.js';

describe('ICA router generation selection', () => {
  const addresses = {
    ethereum: {
      interchainAccountRouter: 'ethereum-v2',
      interchainAccountRouterV3: 'ethereum-v3',
    },
    elysium: {
      interchainAccountRouter: 'elysium-v2',
      interchainAccountRouterV3: 'elysium-v3',
    },
    legacy: { interchainAccountRouter: 'legacy-v2' },
    v3Only: { interchainAccountRouterV3: 'new-v3' },
  };

  it('keeps governance derivation on v2 when checking v3', () => {
    const governance = selectIcaRouterAddresses(addresses, IcaRouterVersion.V2);
    const checking = selectIcaRouterAddresses(addresses, IcaRouterVersion.V3);

    expect(governance.ethereum.interchainAccountRouter).to.equal('ethereum-v2');
    expect(governance.elysium.interchainAccountRouter).to.equal('elysium-v2');
    expect(checking.ethereum.interchainAccountRouter).to.equal('ethereum-v3');
    expect(checking.elysium.interchainAccountRouter).to.equal('elysium-v3');
    expect(addresses.elysium.interchainAccountRouter).to.equal('elysium-v2');
  });

  it('does not enroll a v2 router when a v3 deployment is absent', () => {
    const checking = selectIcaRouterAddresses(addresses, IcaRouterVersion.V3);
    expect(checking).not.to.have.property('legacy');
    expect(checking.v3Only.interchainAccountRouter).to.equal('new-v3');
  });

  it('does not use a v3-only deployment for governance control', () => {
    const governance = selectIcaRouterAddresses(addresses, IcaRouterVersion.V2);
    expect(governance).not.to.have.property('v3Only');
    expect(governance.legacy.interchainAccountRouter).to.equal('legacy-v2');
  });
});
