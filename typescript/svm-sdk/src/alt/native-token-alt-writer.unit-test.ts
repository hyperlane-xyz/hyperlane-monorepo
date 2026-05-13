import { type Address, address } from '@solana/kit';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';

import { HookType } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  type ArtifactDeployed,
  ArtifactState,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type FeeArtifactConfig,
  FeeParamsType,
  FeeType,
} from '@hyperlane-xyz/provider-sdk/fee';
import type { IgpHookConfig } from '@hyperlane-xyz/provider-sdk/hook';
import {
  type DeployedWarpAddress,
  type NativeWarpArtifactConfig,
  TokenType,
} from '@hyperlane-xyz/provider-sdk/warp';

import type { SvmSigner } from '../clients/signer.js';
import { WILDCARD_DOMAIN } from '../codecs/igp.js';
import { SYSTEM_PROGRAM_ADDRESS } from '../constants.js';
import { resolveFeeSalt } from '../fee/types.js';
import { DEFAULT_IGP_SALT } from '../hook/igp-hook.js';
import { H256_ZERO } from '../instructions/fee.js';
import {
  deriveFeeAccountPda,
  deriveHyperlaneTokenPda,
  deriveIgpAccountPda,
  deriveIgpStandingQuotePda,
  deriveMailboxDispatchAuthorityPda,
  deriveNativeCollateralPda,
  deriveStandingQuotePda,
} from '../pda.js';

import { SvmNativeTokenAltWriter } from './native-token-alt-writer.js';

chai.use(chaiAsPromised);

const CHAIN_NAME = 'svm-alt-native-test';
const WARP_PROGRAM: Address = address(
  'BCYqLqWsXmA3sP7VBR1G64rUQXqXM6JzkqpYxbFv5Yu1',
);
const MAILBOX: Address = address(
  'E588QtVUvresuXq2KoNEwAmoifCzYGpRBdHByN9KQMbi',
);
const FEE_PROGRAM: Address = address(
  'F33ip6ZJ4LQHxq3sJTbxsZNG6tWELzETSdpMmFwGV4tT',
);
const IGP_PROGRAM: Address = address(
  'BCYqLqWsXmA3sP7VBR1G64rUQXqXM6JzkqpYxbFv5Yu1',
);
const BENEFICIARY: Address = address(
  'BeneFiCiaRy11111111111111111111111111111111',
);
const REMOTE_ROUTER_HEX = `0x${'aa'.repeat(32)}`;

/**
 * `deriveWarpRouteAddresses` is purely PDA derivation; no signer or
 * rpc methods should be invoked. The mock throws on any access so a
 * future change that accidentally introduces a call here fails loudly
 * instead of returning silent garbage.
 */
function strictUnusedSigner(): SvmSigner {
  return new Proxy({} as object, {
    get(_target, prop) {
      throw new Error(
        `SvmSigner property "${String(prop)}" must not be accessed from this code path`,
      );
    },
  }) as SvmSigner;
}

function deployedNative(args?: {
  fee?: ArtifactDeployed<
    NativeWarpArtifactConfig,
    DeployedWarpAddress
  >['config']['fee'];
  hook?: ArtifactDeployed<
    NativeWarpArtifactConfig,
    DeployedWarpAddress
  >['config']['hook'];
  remoteRouters?: Record<number, { address: string }>;
}): ArtifactDeployed<NativeWarpArtifactConfig, DeployedWarpAddress> {
  return {
    artifactState: ArtifactState.DEPLOYED,
    config: {
      type: TokenType.native,
      owner: '0x0000000000000000000000000000000000000000',
      mailbox: MAILBOX,
      remoteRouters: args?.remoteRouters ?? {},
      destinationGas: {},
      fee: args?.fee,
      hook: args?.hook,
    },
    deployed: { address: WARP_PROGRAM },
  };
}

function igpHookConfig(): IgpHookConfig {
  return {
    type: HookType.INTERCHAIN_GAS_PAYMASTER,
    owner: '0x0000000000000000000000000000000000000000',
    beneficiary: '0x0000000000000000000000000000000000000000',
    oracleKey: '0x0000000000000000000000000000000000000000',
    overhead: {},
    oracleConfig: {},
  };
}

function deployedIgpHook(): ArtifactDeployed<
  IgpHookConfig,
  { address: string }
> {
  return {
    artifactState: ArtifactState.DEPLOYED,
    config: igpHookConfig(),
    deployed: { address: IGP_PROGRAM },
  };
}

function linearFeeConfig(): FeeArtifactConfig {
  return {
    type: FeeType.linear,
    owner: '0x0000000000000000000000000000000000000000',
    beneficiary: BENEFICIARY,
    params: {
      type: FeeParamsType.raw,
      maxFee: '1',
      halfAmount: '1',
    },
  };
}

function deployedLinearFee(): ArtifactDeployed<
  FeeArtifactConfig,
  { address: string }
> {
  return {
    artifactState: ArtifactState.DEPLOYED,
    config: linearFeeConfig(),
    deployed: { address: FEE_PROGRAM },
  };
}

function isSortedAscending<T extends string>(items: T[]): boolean {
  for (let i = 1; i < items.length; i++) {
    if (items[i - 1]! >= items[i]!) return false;
  }
  return true;
}

describe('SvmNativeTokenAltWriter.deriveWarpRouteAddresses', () => {
  const writer = new SvmNativeTokenAltWriter(strictUnusedSigner(), CHAIN_NAME);

  it('returns warp pdas + native collateral pda without fee', async () => {
    const tokenPda = await deriveHyperlaneTokenPda(WARP_PROGRAM);
    const dispatchAuthority =
      await deriveMailboxDispatchAuthorityPda(WARP_PROGRAM);
    const nativeCollateralPda = await deriveNativeCollateralPda(WARP_PROGRAM);

    const result = await writer.deriveWarpRouteAddresses(deployedNative());

    expect(result).to.have.lengthOf(4);
    expect(new Set(result)).to.deep.equal(
      new Set([
        WARP_PROGRAM,
        tokenPda.address,
        dispatchAuthority.address,
        nativeCollateralPda.address,
      ]),
    );
  });

  it('adds fee program + fee account pda + beneficiary when fee is present', async () => {
    const feeAccount = await deriveFeeAccountPda(
      FEE_PROGRAM,
      resolveFeeSalt(CHAIN_NAME),
    );

    const result = await writer.deriveWarpRouteAddresses(
      deployedNative({ fee: deployedLinearFee() }),
    );

    expect(result).to.include.members([
      FEE_PROGRAM,
      feeAccount.address,
      BENEFICIARY,
    ]);
  });

  it('includes per-destination fee cascade addresses for each enrolled remote router', async () => {
    const feeAccount = await deriveFeeAccountPda(
      FEE_PROGRAM,
      resolveFeeSalt(CHAIN_NAME),
    );
    const standing = await deriveStandingQuotePda(
      FEE_PROGRAM,
      feeAccount.address,
      10,
      H256_ZERO,
    );
    const wildcardStanding = await deriveStandingQuotePda(
      FEE_PROGRAM,
      feeAccount.address,
      WILDCARD_DOMAIN,
      H256_ZERO,
    );

    const result = await writer.deriveWarpRouteAddresses(
      deployedNative({
        fee: deployedLinearFee(),
        remoteRouters: { 10: { address: REMOTE_ROUTER_HEX } },
      }),
    );

    expect(result).to.include.members([
      standing.address,
      wildcardStanding.address,
    ]);
  });

  it('rejects when fee is a NEW artifact (caller must expand first)', async () => {
    await expect(
      writer.deriveWarpRouteAddresses(
        deployedNative({
          fee: { artifactState: ArtifactState.NEW, config: linearFeeConfig() },
        }),
      ),
    ).to.be.rejectedWith(/fee/i);
  });

  it('rejects when fee is UNDERIVED (no beneficiary / cascade available)', async () => {
    await expect(
      writer.deriveWarpRouteAddresses(
        deployedNative({
          fee: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: FEE_PROGRAM },
          },
        }),
      ),
    ).to.be.rejectedWith(/fee/i);
  });

  it('includes per-destination IGP cascade addresses when hook is an IGP', async () => {
    const igpAccount = await deriveIgpAccountPda(IGP_PROGRAM, DEFAULT_IGP_SALT);
    const perDest = await deriveIgpStandingQuotePda(
      IGP_PROGRAM,
      igpAccount.address,
      SYSTEM_PROGRAM_ADDRESS,
      10,
      WARP_PROGRAM,
    );
    const perSenderWildcard = await deriveIgpStandingQuotePda(
      IGP_PROGRAM,
      igpAccount.address,
      SYSTEM_PROGRAM_ADDRESS,
      WILDCARD_DOMAIN,
      WARP_PROGRAM,
    );

    const result = await writer.deriveWarpRouteAddresses(
      deployedNative({
        hook: deployedIgpHook(),
        remoteRouters: { 10: { address: REMOTE_ROUTER_HEX } },
      }),
    );

    expect(result).to.include.members([
      perDest.address,
      perSenderWildcard.address,
    ]);
  });

  it('rejects when hook is a NEW artifact', async () => {
    await expect(
      writer.deriveWarpRouteAddresses(
        deployedNative({
          hook: {
            artifactState: ArtifactState.NEW,
            config: igpHookConfig(),
          },
        }),
      ),
    ).to.be.rejectedWith(/hook/i);
  });

  it('rejects when hook is UNDERIVED', async () => {
    await expect(
      writer.deriveWarpRouteAddresses(
        deployedNative({
          hook: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: IGP_PROGRAM },
          },
        }),
      ),
    ).to.be.rejectedWith(/hook/i);
  });

  it('output is sorted ascending and contains no duplicates', async () => {
    const result = await writer.deriveWarpRouteAddresses(
      deployedNative({
        fee: deployedLinearFee(),
        hook: deployedIgpHook(),
        remoteRouters: { 10: { address: REMOTE_ROUTER_HEX } },
      }),
    );

    expect(isSortedAscending([...result])).to.equal(
      true,
      `expected ascending order, got: ${result.join(', ')}`,
    );
    expect(new Set(result).size).to.equal(result.length);
  });
});
