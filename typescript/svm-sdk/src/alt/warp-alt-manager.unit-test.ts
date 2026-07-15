import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';

import {
  type ChainMetadataForAltVM,
  ProtocolType,
} from '@hyperlane-xyz/provider-sdk';

import type { SvmSigner } from '../clients/signer.js';
import type { SvmRpc } from '../types.js';

import { type Address, address } from '@solana/kit';

import {
  SvmAddressLookupTableReader,
  SvmAddressLookupTableWriter,
} from './address-lookup-table.js';
import {
  SvmCollateralTokenAltReader,
  SvmCollateralTokenAltWriter,
} from './collateral-token-alt-writer.js';
import {
  SvmCrossCollateralTokenAltReader,
  SvmCrossCollateralTokenAltWriter,
} from './cross-collateral-token-alt-writer.js';
import {
  SvmNativeTokenAltReader,
  SvmNativeTokenAltWriter,
} from './native-token-alt-writer.js';
import {
  SvmSyntheticTokenAltReader,
  SvmSyntheticTokenAltWriter,
} from './synthetic-token-alt-writer.js';
import {
  SvmWarpAltManager,
  SvmWarpAltReader,
  createWarpAltManager,
  createWarpAltReader,
} from './warp-alt-manager.js';

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

function newReader(): SvmWarpAltReader {
  const altReader = sinon.createStubInstance(SvmAddressLookupTableReader);
  const rpc = new Proxy({} as object, {
    get(_target, prop) {
      throw new Error(
        `SvmRpc method "${String(prop)}" must not be called from this test`,
      );
    },
  }) as SvmRpc;
  return new SvmWarpAltReader(CHAIN_NAME, rpc, altReader);
}

describe('SvmWarpAltReader.read', () => {
  const CORE: Address = address('CoreA1t111111111111111111111111111111111111');
  const WARP_A: Address = address(
    'WarpA1t111111111111111111111111111111111111',
  );
  const WARP_B: Address = address(
    'WarpB1t111111111111111111111111111111111111',
  );

  it('reads the core ALT and each warp-specific ALT through the injected altReader', async () => {
    const altReader = sinon.createStubInstance(SvmAddressLookupTableReader);
    const coreArtifact = { core: 'fake-core' } as never;
    const warpA = { warp: 'fake-warpA' } as never;
    const warpB = { warp: 'fake-warpB' } as never;
    altReader.read.withArgs(CORE).resolves(coreArtifact);
    altReader.read.withArgs(WARP_A).resolves(warpA);
    altReader.read.withArgs(WARP_B).resolves(warpB);

    const rpc = new Proxy({} as object, {
      get(_t, prop) {
        throw new Error(
          `SvmRpc method "${String(prop)}" must not be called from this test`,
        );
      },
    }) as SvmRpc;
    const reader = new SvmWarpAltReader(CHAIN_NAME, rpc, altReader);
    const result = await reader.read({
      core: CORE,
      warpSpecific: [WARP_A, WARP_B],
    });

    expect(altReader.read.callCount).to.equal(3);
    expect(result.core).to.equal(coreArtifact);
    expect(result.warpSpecific).to.deep.equal([warpA, warpB]);
  });
});

describe('SvmWarpAltReader.createReader', () => {
  it('returns SvmNativeTokenAltReader for warp type "native"', () => {
    expect(newReader().createReader('native')).to.be.instanceOf(
      SvmNativeTokenAltReader,
    );
  });

  it('returns SvmCollateralTokenAltReader for warp type "collateral"', () => {
    expect(newReader().createReader('collateral')).to.be.instanceOf(
      SvmCollateralTokenAltReader,
    );
  });

  it('returns SvmSyntheticTokenAltReader for warp type "synthetic"', () => {
    expect(newReader().createReader('synthetic')).to.be.instanceOf(
      SvmSyntheticTokenAltReader,
    );
  });

  it('returns SvmCrossCollateralTokenAltReader for warp type "crossCollateral"', () => {
    expect(newReader().createReader('crossCollateral')).to.be.instanceOf(
      SvmCrossCollateralTokenAltReader,
    );
  });
});

describe('createWarpAltReader', () => {
  it('builds an SvmWarpAltReader from chain metadata (no signer)', () => {
    const reader = createWarpAltReader(chainMetadata());
    expect(reader).to.be.instanceOf(SvmWarpAltReader);
  });

  it('rejects when chain metadata has no rpcUrls', () => {
    expect(() => createWarpAltReader(chainMetadata({ rpcUrls: [] }))).to.throw(
      /RPC URL/,
    );
  });
});
