import { expect } from 'chai';

import { ArtifactState } from './artifact.js';
import type {
  Artifact,
  ArtifactDeployed,
  ArtifactNew,
  ArtifactUnderived,
} from './artifact.js';
import { FeeParamsType, FeeType } from './fee.js';
import type { DeployedFeeAddress, FeeArtifactConfig } from './fee.js';
import type { DeployedHookAddress, HookArtifactConfig } from './hook.js';
import type { DeployedIsmAddress, IsmArtifactConfig } from './ism.js';
import type {
  CollateralWarpArtifactConfig,
  CrossCollateralWarpArtifactConfig,
  SyntheticWarpArtifactConfig,
  WarpArtifactConfig,
  WarpDeployGasBreakdown,
} from './warp.js';
import {
  TokenType,
  composeWarpDeployGas,
  nativeAmountFromGasUnits,
} from './warp.js';

// Arbitrary constants so the helper's logic is tested independently of any
// specific SDK's real numbers.
const BREAKDOWN: WarpDeployGasBreakdown = {
  base: 100n,
  crossCollateralExtra: 10n,
  feeProgram: 1_000n,
  customIsm: 10_000n,
  customHook: 100_000n,
};

interface BaseSharedFixture {
  owner: string;
  mailbox: string;
  remoteRouters: Record<number, { address: string }>;
  destinationGas: Record<number, string>;
}

const baseShared: BaseSharedFixture = {
  owner: '0x1',
  mailbox: '0xMailbox',
  remoteRouters: {},
  destinationGas: {},
};

const feeArtifactConfig: FeeArtifactConfig = {
  type: FeeType.linear,
  owner: '0xOwner',
  beneficiary: '0xBeneficiary',
  token: '0xToken',
  params: { type: FeeParamsType.raw, maxFee: '1000', halfAmount: '500' },
};

const hookArtifactConfig: HookArtifactConfig = {
  type: 'protocolFee',
  owner: '0xOwner',
  maxProtocolFee: '1000',
  protocolFee: '10',
  beneficiary: '0xBeneficiary',
};

const ismArtifactConfig: IsmArtifactConfig = {
  type: 'messageIdMultisigIsm',
  validators: ['0xV1'],
  threshold: 1,
};

const newFee: ArtifactNew<FeeArtifactConfig> = {
  artifactState: ArtifactState.NEW,
  config: feeArtifactConfig,
};

const deployedFee: ArtifactDeployed<FeeArtifactConfig, DeployedFeeAddress> = {
  artifactState: ArtifactState.DEPLOYED,
  config: feeArtifactConfig,
  deployed: { address: '0xFee' },
};

const underivedFee: ArtifactUnderived<DeployedFeeAddress> = {
  artifactState: ArtifactState.UNDERIVED,
  deployed: { address: '0xFee' },
};

const newHook: ArtifactNew<HookArtifactConfig> = {
  artifactState: ArtifactState.NEW,
  config: hookArtifactConfig,
};

const deployedHook: ArtifactDeployed<HookArtifactConfig, DeployedHookAddress> =
  {
    artifactState: ArtifactState.DEPLOYED,
    config: hookArtifactConfig,
    deployed: { address: '0xHook' },
  };

const underivedHook: ArtifactUnderived<DeployedHookAddress> = {
  artifactState: ArtifactState.UNDERIVED,
  deployed: { address: '0xHook' },
};

const newIsm: ArtifactNew<IsmArtifactConfig> = {
  artifactState: ArtifactState.NEW,
  config: ismArtifactConfig,
};

const deployedIsm: ArtifactDeployed<IsmArtifactConfig, DeployedIsmAddress> = {
  artifactState: ArtifactState.DEPLOYED,
  config: ismArtifactConfig,
  deployed: { address: '0xIsm' },
};

const underivedIsm: ArtifactUnderived<DeployedIsmAddress> = {
  artifactState: ArtifactState.UNDERIVED,
  deployed: { address: '0xIsm' },
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

function synthetic(
  overrides: Partial<SyntheticWarpArtifactConfig> = {},
): SyntheticWarpArtifactConfig {
  return {
    ...baseShared,
    type: TokenType.synthetic,
    name: 'Test',
    symbol: 'TST',
    decimals: 18,
    ...overrides,
  };
}

interface Case {
  name: string;
  config: WarpArtifactConfig;
  expected: bigint;
}

const cases: Case[] = [
  {
    name: 'synthetic with no fee/ism/hook returns base only',
    config: synthetic(),
    expected: 100n,
  },
  {
    name: 'collateral with no fee/ism/hook returns base only',
    config: collateral(),
    expected: 100n,
  },
  {
    name: 'crossCollateral with no fee/ism/hook adds crossCollateralExtra',
    config: crossCollateral(),
    expected: 100n + 10n,
  },
  {
    name: 'fee as ArtifactNew adds feeProgram',
    config: collateral({ fee: newFee }),
    expected: 100n + 1_000n,
  },
  {
    name: 'fee as ArtifactDeployed contributes nothing (already deployed)',
    config: collateral({ fee: deployedFee }),
    expected: 100n,
  },
  {
    name: 'fee as ArtifactUnderived contributes nothing (address-only)',
    config: collateral({ fee: underivedFee }),
    expected: 100n,
  },
  {
    name: 'fee undefined contributes nothing',
    config: collateral({ fee: undefined }),
    expected: 100n,
  },
  {
    name: 'ism as ArtifactNew adds customIsm',
    config: collateral({ interchainSecurityModule: newIsm }),
    expected: 100n + 10_000n,
  },
  {
    name: 'ism as ArtifactDeployed contributes nothing',
    config: collateral({ interchainSecurityModule: deployedIsm }),
    expected: 100n,
  },
  {
    name: 'ism as ArtifactUnderived contributes nothing',
    config: collateral({ interchainSecurityModule: underivedIsm }),
    expected: 100n,
  },
  {
    name: 'ism undefined contributes nothing',
    config: collateral({ interchainSecurityModule: undefined }),
    expected: 100n,
  },
  {
    name: 'hook as ArtifactNew adds customHook',
    config: collateral({ hook: newHook }),
    expected: 100n + 100_000n,
  },
  {
    name: 'hook as ArtifactDeployed contributes nothing',
    config: collateral({ hook: deployedHook }),
    expected: 100n,
  },
  {
    name: 'hook as ArtifactUnderived contributes nothing',
    config: collateral({ hook: underivedHook }),
    expected: 100n,
  },
  {
    name: 'hook undefined contributes nothing',
    config: collateral({ hook: undefined }),
    expected: 100n,
  },
  {
    name: 'all-in: crossCollateral + fee-new + ism-new + hook-new sums all deltas',
    config: crossCollateral({
      fee: newFee,
      interchainSecurityModule: newIsm,
      hook: newHook,
    }),
    expected: 100n + 10n + 1_000n + 10_000n + 100_000n,
  },
  {
    name: 'mix: crossCollateral + fee-deployed + ism-new + hook-underived adds only crossCollateralExtra + customIsm',
    config: crossCollateral({
      fee: deployedFee,
      interchainSecurityModule: newIsm,
      hook: underivedHook,
    }),
    expected: 100n + 10n + 10_000n,
  },
];

describe('composeWarpDeployGas', () => {
  for (const c of cases) {
    it(c.name, () => {
      expect(composeWarpDeployGas(c.config, BREAKDOWN)).to.equal(c.expected);
    });
  }

  it('treats an artifact missing artifactState as NEW (defaults to fresh deploy)', () => {
    // When artifactState is undefined, isArtifactNew() returns true.
    const feeMissingState: Artifact<FeeArtifactConfig, DeployedFeeAddress> = {
      config: feeArtifactConfig,
    };
    const config = collateral({ fee: feeMissingState });
    expect(composeWarpDeployGas(config, BREAKDOWN)).to.equal(100n + 1_000n);
  });
});

interface NativeAmountCase {
  name: string;
  gasUnits: bigint;
  amount: string;
  expected: bigint;
}

const nativeAmountCases: NativeAmountCase[] = [
  {
    name: 'integer gas price multiplies exactly',
    gasUnits: 1_000n,
    amount: '5',
    expected: 5_000n,
  },
  {
    name: 'evenly divisible fractional gas price has no remainder to round',
    gasUnits: 1_000n,
    amount: '0.025',
    expected: 25n,
  },
  {
    name: 'non-divisible product rounds up',
    gasUnits: 3n,
    amount: '0.4',
    expected: 2n,
  },
  {
    name: 'tiny non-zero product rounds up to 1',
    gasUnits: 1_000_000n,
    amount: '0.0000000001',
    expected: 1n,
  },
  {
    name: 'zero gas price yields zero',
    gasUnits: 1_000n,
    amount: '0',
    expected: 0n,
  },
];

describe('nativeAmountFromGasUnits', () => {
  for (const c of nativeAmountCases) {
    it(c.name, () => {
      expect(
        nativeAmountFromGasUnits(c.gasUnits, { amount: c.amount }),
      ).to.equal(c.expected);
    });
  }
});
