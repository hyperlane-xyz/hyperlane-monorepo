import { expect } from 'chai';
import { describe, it } from 'mocha';

import {
  composeWarpDeployGas,
  nativeAmountFromGasUnits,
} from '@hyperlane-xyz/provider-sdk/warp';
import type {
  CollateralWarpArtifactConfig,
  WarpArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/warp';
import { TokenType } from '@hyperlane-xyz/provider-sdk/warp';

// Mirrors the private cosmos-native breakdown in clients/provider.ts. Cosmos is
// the only AltVM whose getMinGasForWarpDeploy composes GAS UNITS and then
// multiplies by the chain gas price to yield a native-denom amount, so this
// test pins that two-step path (compose -> multiply-and-floor) end to end.
const COSMOS_BREAKDOWN = {
  base: BigInt(3e6),
  crossCollateralExtra: 0n,
  feeProgram: 0n,
  customIsm: 0n,
  customHook: 0n,
};

interface BaseSharedFixture {
  owner: string;
  mailbox: string;
  remoteRouters: Record<number, { address: string }>;
  destinationGas: Record<number, string>;
}

const baseShared: BaseSharedFixture = {
  owner: '0xOwner',
  mailbox: '0xMailbox',
  remoteRouters: {},
  destinationGas: {},
};

function collateral(): CollateralWarpArtifactConfig {
  return {
    owner: baseShared.owner,
    mailbox: baseShared.mailbox,
    remoteRouters: baseShared.remoteRouters,
    destinationGas: baseShared.destinationGas,
    type: TokenType.collateral,
    token: '0xToken',
  };
}

describe('CosmosNativeProvider warp-deploy gas composition', () => {
  it('multiplies composed gas units by the gas price and floors the result', () => {
    const config: WarpArtifactConfig = collateral();
    const units = composeWarpDeployGas(config, COSMOS_BREAKDOWN);
    expect(units).to.equal(BigInt(3e6));

    // 3_000_000 ugas * 0.025 = 75_000 native denom (exact, no flooring loss).
    expect(nativeAmountFromGasUnits(units, { amount: '0.025' })).to.equal(
      75_000n,
    );

    // A fractional product floors: 3_000_000 * 0.0000004 = 1.2 -> 1.
    expect(nativeAmountFromGasUnits(units, { amount: '0.0000004' })).to.equal(
      1n,
    );
  });
});
