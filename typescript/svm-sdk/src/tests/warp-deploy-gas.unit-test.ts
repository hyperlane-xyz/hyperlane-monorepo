import { expect } from 'chai';
import { describe, it } from 'mocha';

import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import { FeeParamsType, FeeType } from '@hyperlane-xyz/provider-sdk/fee';
import type { FeeArtifactConfig } from '@hyperlane-xyz/provider-sdk/fee';
import type { HookArtifactConfig } from '@hyperlane-xyz/provider-sdk/hook';
import type { IsmArtifactConfig } from '@hyperlane-xyz/provider-sdk/ism';
import type {
  CollateralWarpArtifactConfig,
  CrossCollateralWarpArtifactConfig,
  WarpArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/warp';
import { TokenType } from '@hyperlane-xyz/provider-sdk/warp';

import {
  SvmProtocolProvider,
  WARP_DEPLOY_BASE_LAMPORTS,
  WARP_DEPLOY_CROSS_COLLATERAL_EXTRA_LAMPORTS,
  WARP_DEPLOY_CUSTOM_HOOK_LAMPORTS,
  WARP_DEPLOY_CUSTOM_ISM_LAMPORTS,
  WARP_DEPLOY_FEE_PROGRAM_LAMPORTS,
} from '../clients/protocol.js';

const feeArtifactConfig: FeeArtifactConfig = {
  type: FeeType.linear,
  owner: '0xOwner',
  beneficiary: '0xBeneficiary',
  token: '0xToken',
  params: { type: FeeParamsType.raw, maxFee: '1000', halfAmount: '500' },
};

const ismArtifactConfig: IsmArtifactConfig = {
  type: 'messageIdMultisigIsm',
  validators: ['0xV1'],
  threshold: 1,
};

const hookArtifactConfig: HookArtifactConfig = {
  type: 'protocolFee',
  owner: '0xOwner',
  beneficiary: '0xBeneficiary',
  maxProtocolFee: '1000',
  protocolFee: '10',
};

const baseShared = {
  owner: '0xOwner',
  mailbox: '0xMailbox',
  remoteRouters: {},
  destinationGas: {},
};

function collateral(
  overrides: Partial<CollateralWarpArtifactConfig> = {},
): CollateralWarpArtifactConfig {
  return {
    ...baseShared,
    type: TokenType.collateral,
    token: '0xToken',
    ...overrides,
  };
}

function crossCollateral(
  overrides: Partial<CrossCollateralWarpArtifactConfig> = {},
): CrossCollateralWarpArtifactConfig {
  return {
    ...baseShared,
    type: TokenType.crossCollateral,
    token: '0xToken',
    crossCollateralRouters: {},
    ...overrides,
  };
}

interface Case {
  name: string;
  config: WarpArtifactConfig;
  expected: bigint;
}

// Confirms that Sealevel's observed constants (~2.6 SOL base + ~1.1 SOL
// crossCollateral + ~2.5 SOL fee program) compose as expected via
// composeWarpDeployGas for representative warp shapes.
const cases: Case[] = [
  {
    name: 'base collateral returns WARP_DEPLOY_BASE_LAMPORTS',
    config: collateral(),
    expected: WARP_DEPLOY_BASE_LAMPORTS,
  },
  {
    name: 'crossCollateral adds WARP_DEPLOY_CROSS_COLLATERAL_EXTRA_LAMPORTS',
    config: crossCollateral(),
    expected:
      WARP_DEPLOY_BASE_LAMPORTS + WARP_DEPLOY_CROSS_COLLATERAL_EXTRA_LAMPORTS,
  },
  {
    name: 'crossCollateral + new fee adds WARP_DEPLOY_FEE_PROGRAM_LAMPORTS',
    config: crossCollateral({
      fee: { artifactState: ArtifactState.NEW, config: feeArtifactConfig },
    }),
    expected:
      WARP_DEPLOY_BASE_LAMPORTS +
      WARP_DEPLOY_CROSS_COLLATERAL_EXTRA_LAMPORTS +
      WARP_DEPLOY_FEE_PROGRAM_LAMPORTS,
  },
  {
    name: 'crossCollateral + new fee + new ism + new hook sums every delta',
    config: crossCollateral({
      fee: { artifactState: ArtifactState.NEW, config: feeArtifactConfig },
      interchainSecurityModule: {
        artifactState: ArtifactState.NEW,
        config: ismArtifactConfig,
      },
      hook: { artifactState: ArtifactState.NEW, config: hookArtifactConfig },
    }),
    expected:
      WARP_DEPLOY_BASE_LAMPORTS +
      WARP_DEPLOY_CROSS_COLLATERAL_EXTRA_LAMPORTS +
      WARP_DEPLOY_FEE_PROGRAM_LAMPORTS +
      WARP_DEPLOY_CUSTOM_ISM_LAMPORTS +
      WARP_DEPLOY_CUSTOM_HOOK_LAMPORTS,
  },
];

describe('SvmProtocolProvider.getMinGasForWarpDeploy', () => {
  const provider = new SvmProtocolProvider();

  for (const c of cases) {
    it(c.name, () => {
      expect(provider.getMinGasForWarpDeploy(c.config)).to.equal(c.expected);
    });
  }
});
