import { expect } from 'chai';
import sinon from 'sinon';

import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { WARP_TARGET_ROUTER_NONE } from '@hyperlane-xyz/provider-sdk/quote';
import {
  DEFAULT_ROUTER_KEY,
  type DerivedTokenFeeConfig,
  MultiProvider,
  type OffchainQuotedLinearFeeConfig,
  TokenFeeType,
} from '@hyperlane-xyz/sdk';
import { addressToBytes32 } from '@hyperlane-xyz/utils';

import { resolveTargetRouterForVariant } from '../../deploy/warp-quote.js';

const DEST_CHAIN = 'destchain';
const DEST_DOMAIN = 9999;
const DEST_PROTOCOL = ProtocolType.Ethereum;

const ADDR = '0x' + '00'.repeat(20);
const ROUTER_ADDRESS = '0x' + 'aa'.repeat(20);
const ROUTER_BYTES32 = addressToBytes32(ROUTER_ADDRESS, DEST_PROTOCOL);
const CC_ROUTER_A = '0x' + 'bb'.repeat(20);
const CC_ROUTER_A_BYTES32 = addressToBytes32(CC_ROUTER_A, DEST_PROTOCOL);
const CC_ROUTER_B = '0x' + 'cc'.repeat(20);
const CC_ROUTER_B_BYTES32 = addressToBytes32(CC_ROUTER_B, DEST_PROTOCOL);

// Inner leaf used by RoutingFee / CrossCollateralRoutingFee feeContracts —
// matches TokenFeeConfig (no `address` wrapper, that's only on the outer
// DerivedTokenFeeConfig).
const LEAF: OffchainQuotedLinearFeeConfig = {
  type: TokenFeeType.OffchainQuotedLinearFee,
  token: ADDR,
  owner: ADDR,
  maxFee: 1n,
  halfAmount: 2n,
  bps: 50,
};

// Minimal stub: only tryGetDomainId is read by resolveTargetRouterForVariant.
function makeMultiProvider(): MultiProvider {
  const mp = sinon.createStubInstance(MultiProvider);
  mp.tryGetDomainId.callsFake((chainNameOrId) =>
    chainNameOrId === DEST_CHAIN ? DEST_DOMAIN : null,
  );
  return mp;
}

function callResolve(args: {
  tokenFee: DerivedTokenFeeConfig;
  remoteRouters?: Record<string, { address: string }>;
  crossCollateralRouters?: Record<string, string[]>;
  explicitTargetRouter?: string;
}): string {
  return resolveTargetRouterForVariant({
    tokenFee: args.tokenFee,
    localConfig: {
      remoteRouters: args.remoteRouters,
      crossCollateralRouters: args.crossCollateralRouters,
    },
    multiProvider: makeMultiProvider(),
    destinationChainName: DEST_CHAIN,
    destinationDomain: DEST_DOMAIN,
    destinationProtocol: DEST_PROTOCOL,
    explicitTargetRouter: args.explicitTargetRouter,
  });
}

describe('resolveTargetRouterForVariant', () => {
  it('returns TARGET_ROUTER_NONE for non-CCRF fee types', () => {
    const nonCcrfFixtures: DerivedTokenFeeConfig[] = [
      {
        type: TokenFeeType.LinearFee,
        token: ADDR,
        owner: ADDR,
        maxFee: 1n,
        halfAmount: 2n,
        bps: 50,
        address: ADDR,
      },
      {
        type: TokenFeeType.RegressiveFee,
        token: ADDR,
        owner: ADDR,
        maxFee: 1n,
        halfAmount: 2n,
        address: ADDR,
      },
      {
        type: TokenFeeType.ProgressiveFee,
        token: ADDR,
        owner: ADDR,
        maxFee: 1n,
        halfAmount: 2n,
        address: ADDR,
      },
      {
        type: TokenFeeType.OffchainQuotedLinearFee,
        token: ADDR,
        owner: ADDR,
        maxFee: 1n,
        halfAmount: 2n,
        bps: 50,
        address: ADDR,
      },
      {
        type: TokenFeeType.RoutingFee,
        token: ADDR,
        owner: ADDR,
        feeContracts: { [DEST_CHAIN]: LEAF },
        address: ADDR,
      },
    ];
    for (const tokenFee of nonCcrfFixtures) {
      const result = callResolve({ tokenFee });
      expect(result, `expected NONE for ${tokenFee.type}`).to.equal(
        WARP_TARGET_ROUTER_NONE,
      );
    }
  });

  it('CCRF: returns the specific router key when a matching leaf exists', () => {
    const tokenFee: DerivedTokenFeeConfig = {
      type: TokenFeeType.CrossCollateralRoutingFee,
      owner: ADDR,
      feeContracts: { [DEST_CHAIN]: { [ROUTER_BYTES32]: LEAF } },
      address: ADDR,
    };
    const result = callResolve({
      tokenFee,
      remoteRouters: { [DEST_CHAIN]: { address: ROUTER_ADDRESS } },
    });
    expect(result).to.equal(ROUTER_BYTES32);
  });

  it('CCRF: falls back to DEFAULT_ROUTER_KEY when no specific match', () => {
    const tokenFee: DerivedTokenFeeConfig = {
      type: TokenFeeType.CrossCollateralRoutingFee,
      owner: ADDR,
      feeContracts: { [DEST_CHAIN]: { [DEFAULT_ROUTER_KEY]: LEAF } },
      address: ADDR,
    };
    const result = callResolve({
      tokenFee,
      remoteRouters: { [DEST_CHAIN]: { address: ROUTER_ADDRESS } },
    });
    expect(result).to.equal(DEFAULT_ROUTER_KEY);
  });

  it('CCRF: prefers the specific router key over DEFAULT_ROUTER_KEY', () => {
    const tokenFee: DerivedTokenFeeConfig = {
      type: TokenFeeType.CrossCollateralRoutingFee,
      owner: ADDR,
      feeContracts: {
        [DEST_CHAIN]: { [ROUTER_BYTES32]: LEAF, [DEFAULT_ROUTER_KEY]: LEAF },
      },
      address: ADDR,
    };
    const result = callResolve({
      tokenFee,
      remoteRouters: { [DEST_CHAIN]: { address: ROUTER_ADDRESS } },
    });
    expect(result).to.equal(ROUTER_BYTES32);
  });

  it('CCRF: throws when no leaf is configured for the destination', () => {
    const tokenFee: DerivedTokenFeeConfig = {
      type: TokenFeeType.CrossCollateralRoutingFee,
      owner: ADDR,
      feeContracts: { [DEST_CHAIN]: {} },
      address: ADDR,
    };
    expect(() =>
      callResolve({
        tokenFee,
        remoteRouters: { [DEST_CHAIN]: { address: ROUTER_ADDRESS } },
      }),
    ).to.throw(/no leaf for destination/);
  });

  it('CCRF: resolves a crossCollateralRouters-keyed leaf when the remoteRouter has none', () => {
    const tokenFee: DerivedTokenFeeConfig = {
      type: TokenFeeType.CrossCollateralRoutingFee,
      owner: ADDR,
      feeContracts: { [DEST_CHAIN]: { [CC_ROUTER_A_BYTES32]: LEAF } },
      address: ADDR,
    };

    const result = callResolve({
      tokenFee,
      remoteRouters: { [DEST_CHAIN]: { address: ROUTER_ADDRESS } },
      crossCollateralRouters: { [DEST_CHAIN]: [CC_ROUTER_A] },
    });

    expect(result).to.equal(CC_ROUTER_A_BYTES32);
  });

  it('CCRF: an explicit target router selects the matching leaf', () => {
    const tokenFee: DerivedTokenFeeConfig = {
      type: TokenFeeType.CrossCollateralRoutingFee,
      owner: ADDR,
      feeContracts: {
        [DEST_CHAIN]: {
          [CC_ROUTER_A_BYTES32]: LEAF,
          [CC_ROUTER_B_BYTES32]: LEAF,
        },
      },
      address: ADDR,
    };

    const result = callResolve({
      tokenFee,
      crossCollateralRouters: { [DEST_CHAIN]: [CC_ROUTER_A, CC_ROUTER_B] },
      explicitTargetRouter: CC_ROUTER_B,
    });

    expect(result).to.equal(CC_ROUTER_B_BYTES32);
  });

  it('CCRF: an explicit target router without a leaf throws', () => {
    const tokenFee: DerivedTokenFeeConfig = {
      type: TokenFeeType.CrossCollateralRoutingFee,
      owner: ADDR,
      feeContracts: { [DEST_CHAIN]: { [CC_ROUTER_A_BYTES32]: LEAF } },
      address: ADDR,
    };

    expect(() =>
      callResolve({ tokenFee, explicitTargetRouter: CC_ROUTER_B }),
    ).to.throw(/has no CrossCollateralRoutingFee leaf/);
  });

  it('CCRF: multiple crossCollateralRouters leaves without --target-router throws', () => {
    const tokenFee: DerivedTokenFeeConfig = {
      type: TokenFeeType.CrossCollateralRoutingFee,
      owner: ADDR,
      feeContracts: {
        [DEST_CHAIN]: {
          [CC_ROUTER_A_BYTES32]: LEAF,
          [CC_ROUTER_B_BYTES32]: LEAF,
        },
      },
      address: ADDR,
    };

    expect(() =>
      callResolve({
        tokenFee,
        crossCollateralRouters: { [DEST_CHAIN]: [CC_ROUTER_A, CC_ROUTER_B] },
      }),
    ).to.throw(/multiple router-keyed leaves/);
  });
});
