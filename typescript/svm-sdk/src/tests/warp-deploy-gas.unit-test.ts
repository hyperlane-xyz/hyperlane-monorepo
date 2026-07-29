import { expect } from 'chai';
import { before, describe, it } from 'mocha';

import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import type { ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk/chain';
import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
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

import { SvmProvider } from '../clients/provider.js';

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

// Literal expected totals so a change to any Sealevel deploy-cost constant
// breaks this test: base 2.6 SOL, +1.1 SOL crossCollateral, +2.5 SOL fee
// program. The ISM and hook deltas are currently 0, so adding new ISM/hook
// does not change the total.
const cases: Case[] = [
  {
    name: 'base collateral returns 2.6 SOL',
    config: collateral(),
    expected: 2_600_000_000n,
  },
  {
    name: 'crossCollateral adds 1.1 SOL',
    config: crossCollateral(),
    expected: 3_700_000_000n,
  },
  {
    name: 'crossCollateral + new fee adds 2.5 SOL',
    config: crossCollateral({
      fee: { artifactState: ArtifactState.NEW, config: feeArtifactConfig },
    }),
    expected: 6_200_000_000n,
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
    expected: 6_200_000_000n,
  },
];

const rpcUrls = [{ http: 'http://127.0.0.1:8899' }];
const chainMetadata: ChainMetadataForAltVM = {
  name: 'solanamainnet',
  protocol: ProtocolType.Sealevel,
  chainId: 1399811149,
  domainId: 1399811149,
  rpcUrls,
};

describe('SvmProvider.getMinGasForWarpDeploy', () => {
  let provider: SvmProvider;

  before(async () => {
    provider = await SvmProvider.connect(chainMetadata);
  });

  for (const c of cases) {
    it(c.name, async () => {
      expect(await provider.getMinGasForWarpDeploy(c.config)).to.equal(
        c.expected,
      );
    });
  }
});
