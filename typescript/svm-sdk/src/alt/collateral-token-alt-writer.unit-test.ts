import { type Address, address } from '@solana/kit';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';

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
  type CollateralWarpArtifactConfig,
  type DeployedWarpAddress,
  TokenType,
} from '@hyperlane-xyz/provider-sdk/warp';

import { WILDCARD_DOMAIN } from '../codecs/igp.js';
import {
  SPL_TOKEN_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
} from '../constants.js';
import { resolveFeeSalt } from '../fee/types.js';
import { DEFAULT_IGP_SALT } from '../hook/igp-hook.js';
import { H256_ZERO } from '../instructions/fee.js';
import {
  deriveAssociatedTokenAddress,
  deriveEscrowPda,
  deriveFeeAccountPda,
  deriveHyperlaneTokenPda,
  deriveIgpAccountPda,
  deriveIgpStandingQuotePda,
  deriveMailboxDispatchAuthorityPda,
  deriveStandingQuotePda,
} from '../pda.js';
import type { SvmRpc } from '../types.js';

import { SvmAddressLookupTableWriter } from './address-lookup-table.js';
import { SvmCollateralTokenAltWriter } from './collateral-token-alt-writer.js';

chai.use(chaiAsPromised);

const CHAIN_NAME = 'svm-alt-collateral-test';
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
const MINT: Address = address('M1ntCo11atera111111111111111111111111111111');
const BENEFICIARY_OWNER: Address = address(
  'BeneFiCiaRy11111111111111111111111111111111',
);
const REMOTE_ROUTER_HEX = `0x${'aa'.repeat(32)}`;

/**
 * Stubs only the `getAccountInfo` rpc method that `fetchMintTokenProgram`
 * reaches for; everything else throws if accidentally touched so a future
 * change that adds an unexpected rpc call surfaces loudly.
 */
function rpcWithMintOwner(owner: Address): SvmRpc {
  return new Proxy({} as object, {
    get(_target, prop) {
      if (prop === 'getAccountInfo') {
        return () => ({
          send: async () => ({
            value: {
              owner,
              data: ['', 'base64'],
              executable: false,
              lamports: 0,
              rentEpoch: 0,
            },
          }),
        });
      }
      throw new Error(
        `SvmRpc method "${String(prop)}" must not be called from this code path`,
      );
    },
  }) as SvmRpc;
}

function stubAltWriter(): sinon.SinonStubbedInstance<SvmAddressLookupTableWriter> {
  return sinon.createStubInstance(SvmAddressLookupTableWriter);
}

function deployedCollateral(args?: {
  fee?: ArtifactDeployed<
    CollateralWarpArtifactConfig,
    DeployedWarpAddress
  >['config']['fee'];
  hook?: ArtifactDeployed<
    CollateralWarpArtifactConfig,
    DeployedWarpAddress
  >['config']['hook'];
  remoteRouters?: Record<number, { address: string }>;
}): ArtifactDeployed<CollateralWarpArtifactConfig, DeployedWarpAddress> {
  return {
    artifactState: ArtifactState.DEPLOYED,
    config: {
      type: TokenType.collateral,
      owner: '0x0000000000000000000000000000000000000000',
      mailbox: MAILBOX,
      token: MINT,
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
    beneficiary: BENEFICIARY_OWNER,
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

describe('SvmCollateralTokenAltWriter.deriveWarpRouteAddresses', () => {
  it('returns warp pdas + plugin static (SPL Token mint case) without fee/hook', async () => {
    const writer = new SvmCollateralTokenAltWriter(
      CHAIN_NAME,
      rpcWithMintOwner(SPL_TOKEN_PROGRAM_ADDRESS),
      stubAltWriter(),
    );
    const tokenPda = await deriveHyperlaneTokenPda(WARP_PROGRAM);
    const dispatchAuthority =
      await deriveMailboxDispatchAuthorityPda(WARP_PROGRAM);
    const escrowPda = await deriveEscrowPda(WARP_PROGRAM);

    const result = await writer.deriveWarpRouteAddresses(deployedCollateral());

    expect(result).to.have.lengthOf(6);
    expect(new Set(result)).to.deep.equal(
      new Set([
        WARP_PROGRAM,
        tokenPda.address,
        dispatchAuthority.address,
        SPL_TOKEN_PROGRAM_ADDRESS,
        MINT,
        escrowPda.address,
      ]),
    );
  });

  it('uses Token-2022 program id in plugin static when the mint is owned by Token-2022', async () => {
    const writer = new SvmCollateralTokenAltWriter(
      CHAIN_NAME,
      rpcWithMintOwner(TOKEN_2022_PROGRAM_ADDRESS),
      stubAltWriter(),
    );
    const result = await writer.deriveWarpRouteAddresses(deployedCollateral());

    expect(result).to.include(TOKEN_2022_PROGRAM_ADDRESS);
    expect(result).to.not.include(SPL_TOKEN_PROGRAM_ADDRESS);
  });

  it('adds fee program + fee account pda + beneficiary ATA when fee is present', async () => {
    const writer = new SvmCollateralTokenAltWriter(
      CHAIN_NAME,
      rpcWithMintOwner(SPL_TOKEN_PROGRAM_ADDRESS),
      stubAltWriter(),
    );
    const feeAccount = await deriveFeeAccountPda(
      FEE_PROGRAM,
      resolveFeeSalt(CHAIN_NAME),
    );
    const beneficiaryAta = await deriveAssociatedTokenAddress({
      wallet: BENEFICIARY_OWNER,
      mint: MINT,
      tokenProgram: SPL_TOKEN_PROGRAM_ADDRESS,
    });

    const result = await writer.deriveWarpRouteAddresses(
      deployedCollateral({ fee: deployedLinearFee() }),
    );

    expect(result).to.include.members([
      FEE_PROGRAM,
      feeAccount.address,
      beneficiaryAta.address,
    ]);
    // For SPL fees the wallet itself is not in the output — only the ATA.
    expect(result).to.not.include(BENEFICIARY_OWNER);
  });

  it('includes per-destination fee cascade addresses for each enrolled remote router', async () => {
    const writer = new SvmCollateralTokenAltWriter(
      CHAIN_NAME,
      rpcWithMintOwner(SPL_TOKEN_PROGRAM_ADDRESS),
      stubAltWriter(),
    );
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
      deployedCollateral({
        fee: deployedLinearFee(),
        remoteRouters: { 10: { address: REMOTE_ROUTER_HEX } },
      }),
    );

    expect(result).to.include.members([
      standing.address,
      wildcardStanding.address,
    ]);
  });

  it('uses the collateral mint as IGP feeTokenMint', async () => {
    const writer = new SvmCollateralTokenAltWriter(
      CHAIN_NAME,
      rpcWithMintOwner(SPL_TOKEN_PROGRAM_ADDRESS),
      stubAltWriter(),
    );
    const igpAccount = await deriveIgpAccountPda(IGP_PROGRAM, DEFAULT_IGP_SALT);
    const perDestMintCascade = await deriveIgpStandingQuotePda(
      IGP_PROGRAM,
      igpAccount.address,
      MINT,
      10,
      WARP_PROGRAM,
    );

    const result = await writer.deriveWarpRouteAddresses(
      deployedCollateral({
        hook: deployedIgpHook(),
        remoteRouters: { 10: { address: REMOTE_ROUTER_HEX } },
      }),
    );

    expect(result).to.include(perDestMintCascade.address);
  });

  it('rejects when fee is a NEW artifact (caller must expand first)', async () => {
    const writer = new SvmCollateralTokenAltWriter(
      CHAIN_NAME,
      rpcWithMintOwner(SPL_TOKEN_PROGRAM_ADDRESS),
      stubAltWriter(),
    );
    await expect(
      writer.deriveWarpRouteAddresses(
        deployedCollateral({
          fee: { artifactState: ArtifactState.NEW, config: linearFeeConfig() },
        }),
      ),
    ).to.be.rejectedWith(/fee/i);
  });

  it('rejects when hook is UNDERIVED', async () => {
    const writer = new SvmCollateralTokenAltWriter(
      CHAIN_NAME,
      rpcWithMintOwner(SPL_TOKEN_PROGRAM_ADDRESS),
      stubAltWriter(),
    );
    await expect(
      writer.deriveWarpRouteAddresses(
        deployedCollateral({
          hook: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: IGP_PROGRAM },
          },
        }),
      ),
    ).to.be.rejectedWith(/hook/i);
  });

  it('output is sorted ascending and contains no duplicates', async () => {
    const writer = new SvmCollateralTokenAltWriter(
      CHAIN_NAME,
      rpcWithMintOwner(SPL_TOKEN_PROGRAM_ADDRESS),
      stubAltWriter(),
    );
    const result = await writer.deriveWarpRouteAddresses(
      deployedCollateral({
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

const CORE_ALT_ADDRESS: Address = address(
  'CoreA1t111111111111111111111111111111111111',
);
const WARP_ALT_ADDRESS: Address = address(
  'WarpA1t111111111111111111111111111111111111',
);

function frozenAltAt(
  altAddress: Address,
  addresses: Address[],
): ArtifactDeployed<
  { frozen: true; addresses: readonly [Address, ...Address[]] },
  { address: Address; authority: null; lastExtendedSlot: bigint }
> {
  return {
    artifactState: ArtifactState.DEPLOYED,
    config: {
      frozen: true,
      addresses: [addresses[0]!, ...addresses.slice(1)],
    },
    deployed: { address: altAddress, authority: null, lastExtendedSlot: 0n },
  };
}

describe('SvmCollateralTokenAltWriter.create', () => {
  it('creates the core and warp-specific ALTs (frozen) and returns their addresses + receipts', async () => {
    const altWriter = stubAltWriter();
    altWriter.create
      .onFirstCall()
      .resolves([
        frozenAltAt(CORE_ALT_ADDRESS, [WARP_PROGRAM]),
        [{ signature: 'core-sig' }],
      ])
      .onSecondCall()
      .resolves([
        frozenAltAt(WARP_ALT_ADDRESS, [WARP_PROGRAM]),
        [{ signature: 'warp-sig-1' }, { signature: 'warp-sig-2' }],
      ]);

    const writer = new SvmCollateralTokenAltWriter(
      CHAIN_NAME,
      rpcWithMintOwner(SPL_TOKEN_PROGRAM_ADDRESS),
      altWriter,
    );

    const result = await writer.create(
      deployedCollateral({
        fee: deployedLinearFee(),
        hook: deployedIgpHook(),
        remoteRouters: { 10: { address: REMOTE_ROUTER_HEX } },
      }),
    );

    expect(altWriter.create.callCount).to.equal(2);
    expect(altWriter.create.firstCall.args[0].config.frozen).to.equal(true);
    expect(altWriter.create.secondCall.args[0].config.frozen).to.equal(true);

    expect(result.core).to.equal(CORE_ALT_ADDRESS);
    expect(result.warpSpecific).to.deep.equal([WARP_ALT_ADDRESS]);
    expect(result.receipts).to.have.lengthOf(3);
  });
});

describe('SvmCollateralTokenAltWriter.read', () => {
  it('reads the core ALT and every warp-specific ALT through the injected altWriter', async () => {
    const altWriter = stubAltWriter();
    const coreAlt = frozenAltAt(CORE_ALT_ADDRESS, [WARP_PROGRAM]);
    const warpAlt = frozenAltAt(WARP_ALT_ADDRESS, [MINT]);
    altWriter.read.withArgs(CORE_ALT_ADDRESS).resolves(coreAlt);
    altWriter.read.withArgs(WARP_ALT_ADDRESS).resolves(warpAlt);

    const writer = new SvmCollateralTokenAltWriter(
      CHAIN_NAME,
      rpcWithMintOwner(SPL_TOKEN_PROGRAM_ADDRESS),
      altWriter,
    );
    const result = await writer.read({
      core: CORE_ALT_ADDRESS,
      warpSpecific: [WARP_ALT_ADDRESS],
    });

    expect(result.core).to.equal(coreAlt);
    expect(result.warpSpecific).to.deep.equal([warpAlt]);
  });
});

describe('SvmCollateralTokenAltWriter.check', () => {
  async function expectedAddressesFor(
    deployed: ArtifactDeployed<
      CollateralWarpArtifactConfig,
      DeployedWarpAddress
    >,
  ): Promise<{ core: Address[]; warpSpecific: Address[] }> {
    const altWriter = stubAltWriter();
    altWriter.create.resolves([
      frozenAltAt(CORE_ALT_ADDRESS, [WARP_PROGRAM]),
      [],
    ]);
    const writer = new SvmCollateralTokenAltWriter(
      CHAIN_NAME,
      rpcWithMintOwner(SPL_TOKEN_PROGRAM_ADDRESS),
      altWriter,
    );
    await writer.create(deployed);
    return {
      core: [...altWriter.create.firstCall.args[0].config.addresses],
      warpSpecific: [...altWriter.create.secondCall.args[0].config.addresses],
    };
  }

  it('returns empty diffs when on-chain ALTs match the regenerated expected set', async () => {
    const deployed = deployedCollateral({
      fee: deployedLinearFee(),
      hook: deployedIgpHook(),
      remoteRouters: { 10: { address: REMOTE_ROUTER_HEX } },
    });
    const expected = await expectedAddressesFor(deployed);

    const altWriter = stubAltWriter();
    altWriter.read
      .withArgs(CORE_ALT_ADDRESS)
      .resolves(frozenAltAt(CORE_ALT_ADDRESS, expected.core));
    altWriter.read
      .withArgs(WARP_ALT_ADDRESS)
      .resolves(frozenAltAt(WARP_ALT_ADDRESS, expected.warpSpecific));
    const writer = new SvmCollateralTokenAltWriter(
      CHAIN_NAME,
      rpcWithMintOwner(SPL_TOKEN_PROGRAM_ADDRESS),
      altWriter,
    );

    const diff = await writer.check(
      { core: CORE_ALT_ADDRESS, warpSpecific: [WARP_ALT_ADDRESS] },
      deployed,
    );

    expect(diff.core).to.deep.equal({
      missingFromAlt: [],
      extraInAlt: [],
      frozenMismatch: false,
    });
    expect(diff.warpSpecific).to.deep.equal({
      missingFromAlt: [],
      extraInAlt: [],
      frozenMismatch: false,
    });
  });

  it('reports missing and extra addresses per bucket', async () => {
    const deployed = deployedCollateral({
      fee: deployedLinearFee(),
      hook: deployedIgpHook(),
      remoteRouters: { 10: { address: REMOTE_ROUTER_HEX } },
    });
    const expected = await expectedAddressesFor(deployed);

    const junk: Address = address(
      'Junk111111111111111111111111111111111111111',
    );
    const actualCore = [...expected.core.slice(1), junk];
    const actualWarp = [...expected.warpSpecific.slice(1), junk];

    const altWriter = stubAltWriter();
    altWriter.read
      .withArgs(CORE_ALT_ADDRESS)
      .resolves(frozenAltAt(CORE_ALT_ADDRESS, actualCore));
    altWriter.read
      .withArgs(WARP_ALT_ADDRESS)
      .resolves(frozenAltAt(WARP_ALT_ADDRESS, actualWarp));
    const writer = new SvmCollateralTokenAltWriter(
      CHAIN_NAME,
      rpcWithMintOwner(SPL_TOKEN_PROGRAM_ADDRESS),
      altWriter,
    );

    const diff = await writer.check(
      { core: CORE_ALT_ADDRESS, warpSpecific: [WARP_ALT_ADDRESS] },
      deployed,
    );

    expect(diff.core.missingFromAlt).to.deep.equal([expected.core[0]]);
    expect(diff.core.extraInAlt).to.deep.equal([junk]);
    expect(diff.warpSpecific.missingFromAlt).to.deep.equal([
      expected.warpSpecific[0],
    ]);
    expect(diff.warpSpecific.extraInAlt).to.deep.equal([junk]);
  });

  it('flags frozenMismatch when any on-chain ALT is unfrozen', async () => {
    const deployed = deployedCollateral();
    const expected = await expectedAddressesFor(deployed);

    const altWriter = stubAltWriter();
    altWriter.read.withArgs(CORE_ALT_ADDRESS).resolves({
      artifactState: ArtifactState.DEPLOYED,
      config: { frozen: false, addresses: expected.core },
      deployed: {
        address: CORE_ALT_ADDRESS,
        authority: WARP_PROGRAM,
        lastExtendedSlot: 0n,
      },
    });
    altWriter.read
      .withArgs(WARP_ALT_ADDRESS)
      .resolves(frozenAltAt(WARP_ALT_ADDRESS, expected.warpSpecific));
    const writer = new SvmCollateralTokenAltWriter(
      CHAIN_NAME,
      rpcWithMintOwner(SPL_TOKEN_PROGRAM_ADDRESS),
      altWriter,
    );

    const diff = await writer.check(
      { core: CORE_ALT_ADDRESS, warpSpecific: [WARP_ALT_ADDRESS] },
      deployed,
    );

    expect(diff.core.frozenMismatch).to.equal(true);
    expect(diff.warpSpecific.frozenMismatch).to.equal(false);
  });
});
