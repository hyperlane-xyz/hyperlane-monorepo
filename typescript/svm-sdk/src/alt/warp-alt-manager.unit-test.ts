import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';

import {
  type ChainMetadataForAltVM,
  ProtocolType,
} from '@hyperlane-xyz/provider-sdk';

import type { SvmSigner } from '../clients/signer.js';
import type { SvmRpc } from '../types.js';

import { SvmAddressLookupTableWriter } from './address-lookup-table.js';
import { SvmCollateralTokenAltWriter } from './collateral-token-alt-writer.js';
import { SvmCrossCollateralTokenAltWriter } from './cross-collateral-token-alt-writer.js';
import { SvmNativeTokenAltWriter } from './native-token-alt-writer.js';
import { SvmSyntheticTokenAltWriter } from './synthetic-token-alt-writer.js';
import { SvmWarpAltManager, createWarpAltManager } from './warp-alt-manager.js';

chai.use(chaiAsPromised);

const CHAIN_NAME = 'svm-alt-manager-test';

function newManager(): SvmWarpAltManager {
  // None of the manager's `createWriter` paths touch the rpc or
  // altWriter at instantiation time — the writers cache them and use
  // them only when their own methods are called. Plain stubs are
  // enough; this test only verifies dispatch.
  const altWriter = sinon.createStubInstance(SvmAddressLookupTableWriter);
  const rpc = new Proxy({} as object, {
    get(_target, prop) {
      throw new Error(
        `SvmRpc method "${String(prop)}" must not be called from this test`,
      );
    },
  }) as SvmRpc;
  return new SvmWarpAltManager(CHAIN_NAME, rpc, altWriter);
}

describe('SvmWarpAltManager.createWriter', () => {
  it('returns SvmNativeTokenAltWriter for warp type "native"', () => {
    expect(newManager().createWriter('native')).to.be.instanceOf(
      SvmNativeTokenAltWriter,
    );
  });

  it('returns SvmCollateralTokenAltWriter for warp type "collateral"', () => {
    expect(newManager().createWriter('collateral')).to.be.instanceOf(
      SvmCollateralTokenAltWriter,
    );
  });

  it('returns SvmSyntheticTokenAltWriter for warp type "synthetic"', () => {
    expect(newManager().createWriter('synthetic')).to.be.instanceOf(
      SvmSyntheticTokenAltWriter,
    );
  });

  it('returns SvmCrossCollateralTokenAltWriter for warp type "crossCollateral"', () => {
    expect(newManager().createWriter('crossCollateral')).to.be.instanceOf(
      SvmCrossCollateralTokenAltWriter,
    );
  });
});

function chainMetadata(args?: {
  rpcUrls?: { http: string }[];
}): ChainMetadataForAltVM {
  return {
    name: 'svm-alt-manager-test',
    protocol: ProtocolType.Sealevel,
    domainId: 1399811149,
    chainId: 1399811149,
    rpcUrls: args?.rpcUrls ?? [{ http: 'http://localhost:8899' }],
  };
}

const FAKE_SIGNER = {} as SvmSigner;

describe('createWarpAltManager', () => {
  it('builds an SvmWarpAltManager from chain metadata + signer', () => {
    const manager = createWarpAltManager(chainMetadata(), FAKE_SIGNER);
    expect(manager).to.be.instanceOf(SvmWarpAltManager);
    // Sanity: the manager dispatches correctly after factory wiring.
    expect(manager.createWriter('native')).to.be.instanceOf(
      SvmNativeTokenAltWriter,
    );
  });

  it('rejects when chain metadata has no rpcUrls', () => {
    expect(() =>
      createWarpAltManager(chainMetadata({ rpcUrls: [] }), FAKE_SIGNER),
    ).to.throw(/RPC URL/);
  });
});
