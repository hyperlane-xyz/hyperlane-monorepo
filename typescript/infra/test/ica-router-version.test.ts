import assert, { rejects } from 'node:assert/strict';

import { expect } from 'chai';
import sinon from 'sinon';

import { MultiProvider } from '@hyperlane-xyz/sdk';

import { Contexts } from '../config/contexts.js';
import { environment } from '../config/environments/mainnet3/index.js';
import { getRegistry } from '../config/registry.js';
import { Modules } from '../scripts/agent-utils.js';
import { getGovernor } from '../scripts/check/check-utils.js';

import {
  IcaRouterVersion,
  selectIcaRouterAddresses,
} from '../scripts/check/ica-router-version.js';

describe('ICA router generation selection', () => {
  afterEach(() => sinon.restore());
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

  it('rejects a requested chain whose selected generation is absent', () => {
    expect(() =>
      selectIcaRouterAddresses(addresses, IcaRouterVersion.V3, ['legacy']),
    ).to.throw('Missing v3 ICA routers for requested chains: legacy');
  });

  it('validates the fork target when no chains are specified', async () => {
    const registry = getRegistry();
    const base = registry.getChainAddresses('base');
    assert(base?.interchainAccountRouter);
    const v2Only = { ...base };
    delete v2Only.interchainAccountRouterV3;
    sinon.stub(registry, 'getAddresses').returns({ base: v2Only });
    const mp = new MultiProvider(registry.getMetadata());
    const getProvider = sinon.spy(mp, 'getProvider');
    await rejects(
      getGovernor(
        Modules.INTERCHAIN_ACCOUNTS,
        Contexts.Hyperlane,
        'mainnet3',
        false,
        undefined,
        'base',
        false,
        mp,
        IcaRouterVersion.V3,
      ),
      /Missing v3 ICA routers for requested chains: base/,
    );
    expect(getProvider.called).to.equal(false);
  });

  it('constructs ICA and HAAS checkers with only v3 deployments and no v2 controller', async () => {
    const registry = getRegistry();
    // Build the environment config from the complete registry before limiting
    // the address fixture to the one selected-generation deployment.
    void environment.core;
    const base = registry.getChainAddresses('base');
    assert(base?.interchainAccountRouterV3);
    const v3Only = { ...base };
    delete v3Only.interchainAccountRouter;
    sinon.stub(registry, 'getAddresses').returns({ base: v3Only });
    for (const module of [Modules.INTERCHAIN_ACCOUNTS, Modules.HAAS]) {
      const governor = await getGovernor(
        module,
        Contexts.Hyperlane,
        'mainnet3',
        false,
        ['base'],
        undefined,
        false,
        new MultiProvider(registry.getMetadata()),
        IcaRouterVersion.V3,
      );
      expect(governor.interchainAccount).to.equal(undefined);
      const calls = await governor.prepareGovernanceCalls();
      expect(
        Object.values(calls).every((chainCalls) => chainCalls.length === 0),
      ).to.equal(true);
    }
  });
});
