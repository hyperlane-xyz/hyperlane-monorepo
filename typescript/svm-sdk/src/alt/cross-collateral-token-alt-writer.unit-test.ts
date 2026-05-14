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
  type CrossCollateralWarpArtifactConfig,
  type DeployedWarpAddress,
  TokenType,
} from '@hyperlane-xyz/provider-sdk/warp';

import { DEFAULT_ROUTER } from '../codecs/fee.js';
import { WILDCARD_DOMAIN } from '../codecs/igp.js';
import {
  SPL_TOKEN_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
} from '../constants.js';
import { resolveFeeSalt } from '../fee/types.js';
import { DEFAULT_IGP_SALT } from '../hook/igp-hook.js';
import {
  deriveAssociatedTokenAddress,
  deriveCrossCollateralRoutePda,
  deriveCrossCollateralStatePda,
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
import { SvmCrossCollateralTokenAltWriter } from './cross-collateral-token-alt-writer.js';

chai.use(chaiAsPromised);

const CHAIN_NAME = 'svm-alt-cc-test';
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
const REMOTE_ROUTER_BYTES = Uint8Array.from({ length: 32 }, () => 0xaa);

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

function deployedCc(args?: {
  fee?: ArtifactDeployed<
    CrossCollateralWarpArtifactConfig,
    DeployedWarpAddress
  >['config']['fee'];
  hook?: ArtifactDeployed<
    CrossCollateralWarpArtifactConfig,
    DeployedWarpAddress
  >['config']['hook'];
  remoteRouters?: Record<number, { address: string }>;
  crossCollateralRouters?: Record<number, Set<string>>;
}): ArtifactDeployed<CrossCollateralWarpArtifactConfig, DeployedWarpAddress> {
  return {
    artifactState: ArtifactState.DEPLOYED,
    config: {
      type: TokenType.crossCollateral,
      owner: '0x0000000000000000000000000000000000000000',
      mailbox: MAILBOX,
      token: MINT,
      crossCollateralRouters: args?.crossCollateralRouters ?? {},
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

function ccFeeConfig(): FeeArtifactConfig {
  return {
    type: FeeType.crossCollateralRouting,
    owner: '0x0000000000000000000000000000000000000000',
    beneficiary: BENEFICIARY_OWNER,
    routes: {},
  };
}

function deployedCcFee(): ArtifactDeployed<
  FeeArtifactConfig,
  { address: string }
> {
  return {
    artifactState: ArtifactState.DEPLOYED,
    config: ccFeeConfig(),
    deployed: { address: FEE_PROGRAM },
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

describe('SvmCrossCollateralTokenAltWriter.deriveWarpRouteAddresses', () => {
  it('returns warp pdas + plugin static including cc_state_pda (SPL Token case) without fee/hook', async () => {
    const writer = new SvmCrossCollateralTokenAltWriter(
      CHAIN_NAME,
      rpcWithMintOwner(SPL_TOKEN_PROGRAM_ADDRESS),
      stubAltWriter(),
    );
    const tokenPda = await deriveHyperlaneTokenPda(WARP_PROGRAM);
    const dispatchAuthority =
      await deriveMailboxDispatchAuthorityPda(WARP_PROGRAM);
    const escrowPda = await deriveEscrowPda(WARP_PROGRAM);
    const ccStatePda = await deriveCrossCollateralStatePda(WARP_PROGRAM);

    const result = await writer.deriveWarpRouteAddresses(deployedCc());

    expect(result).to.have.lengthOf(7);
    expect(new Set(result)).to.deep.equal(
      new Set([
        WARP_PROGRAM,
        tokenPda.address,
        dispatchAuthority.address,
        SPL_TOKEN_PROGRAM_ADDRESS,
        MINT,
        escrowPda.address,
        ccStatePda.address,
      ]),
    );
  });

  it('uses Token-2022 program id when the mint is Token-2022 owned', async () => {
    const writer = new SvmCrossCollateralTokenAltWriter(
      CHAIN_NAME,
      rpcWithMintOwner(TOKEN_2022_PROGRAM_ADDRESS),
      stubAltWriter(),
    );
    const result = await writer.deriveWarpRouteAddresses(deployedCc());

    expect(result).to.include(TOKEN_2022_PROGRAM_ADDRESS);
    expect(result).to.not.include(SPL_TOKEN_PROGRAM_ADDRESS);
  });

  it('with CC fee config: includes per-(domain, target_router) cascade + DEFAULT_ROUTER PDAs', async () => {
    const writer = new SvmCrossCollateralTokenAltWriter(
      CHAIN_NAME,
      rpcWithMintOwner(SPL_TOKEN_PROGRAM_ADDRESS),
      stubAltWriter(),
    );
    const feeAccount = await deriveFeeAccountPda(
      FEE_PROGRAM,
      resolveFeeSalt(CHAIN_NAME),
    );
    const ccRouteSpecific = await deriveCrossCollateralRoutePda(
      FEE_PROGRAM,
      feeAccount.address,
      10,
      REMOTE_ROUTER_BYTES,
    );
    const ccRouteDefault = await deriveCrossCollateralRoutePda(
      FEE_PROGRAM,
      feeAccount.address,
      10,
      DEFAULT_ROUTER,
    );
    const standingSpecific = await deriveStandingQuotePda(
      FEE_PROGRAM,
      feeAccount.address,
      10,
      REMOTE_ROUTER_BYTES,
    );
    const standingDefault = await deriveStandingQuotePda(
      FEE_PROGRAM,
      feeAccount.address,
      10,
      DEFAULT_ROUTER,
    );
    const wildcardSpecific = await deriveStandingQuotePda(
      FEE_PROGRAM,
      feeAccount.address,
      WILDCARD_DOMAIN,
      REMOTE_ROUTER_BYTES,
    );

    const result = await writer.deriveWarpRouteAddresses(
      deployedCc({
        fee: deployedCcFee(),
        crossCollateralRouters: { 10: new Set([REMOTE_ROUTER_HEX]) },
      }),
    );

    expect(result).to.include.members([
      ccRouteSpecific.address,
      ccRouteDefault.address,
      standingSpecific.address,
      standingDefault.address,
      wildcardSpecific.address,
    ]);
  });

  it('with leaf fee config: includes the leaf cascade keyed by H256::zero', async () => {
    const writer = new SvmCrossCollateralTokenAltWriter(
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
      deployedCc({
        fee: deployedLinearFee(),
        remoteRouters: { 10: { address: REMOTE_ROUTER_HEX } },
      }),
    );

    expect(result).to.include.members([
      FEE_PROGRAM,
      feeAccount.address,
      beneficiaryAta.address,
    ]);
  });

  it('uses the collateral mint as IGP feeTokenMint', async () => {
    const writer = new SvmCrossCollateralTokenAltWriter(
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
      deployedCc({
        hook: deployedIgpHook(),
        remoteRouters: { 10: { address: REMOTE_ROUTER_HEX } },
      }),
    );

    expect(result).to.include(perDestMintCascade.address);
  });

  it('rejects when fee is a NEW artifact', async () => {
    const writer = new SvmCrossCollateralTokenAltWriter(
      CHAIN_NAME,
      rpcWithMintOwner(SPL_TOKEN_PROGRAM_ADDRESS),
      stubAltWriter(),
    );
    await expect(
      writer.deriveWarpRouteAddresses(
        deployedCc({
          fee: { artifactState: ArtifactState.NEW, config: ccFeeConfig() },
        }),
      ),
    ).to.be.rejectedWith(/fee/i);
  });

  it('rejects when hook is UNDERIVED', async () => {
    const writer = new SvmCrossCollateralTokenAltWriter(
      CHAIN_NAME,
      rpcWithMintOwner(SPL_TOKEN_PROGRAM_ADDRESS),
      stubAltWriter(),
    );
    await expect(
      writer.deriveWarpRouteAddresses(
        deployedCc({
          hook: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: IGP_PROGRAM },
          },
        }),
      ),
    ).to.be.rejectedWith(/hook/i);
  });

  it('output is sorted ascending and contains no duplicates', async () => {
    const writer = new SvmCrossCollateralTokenAltWriter(
      CHAIN_NAME,
      rpcWithMintOwner(SPL_TOKEN_PROGRAM_ADDRESS),
      stubAltWriter(),
    );
    const result = await writer.deriveWarpRouteAddresses(
      deployedCc({
        fee: deployedCcFee(),
        hook: deployedIgpHook(),
        crossCollateralRouters: { 10: new Set([REMOTE_ROUTER_HEX]) },
      }),
    );

    expect(isSortedAscending([...result])).to.equal(true);
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

describe('SvmCrossCollateralTokenAltWriter.create', () => {
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

    const writer = new SvmCrossCollateralTokenAltWriter(
      CHAIN_NAME,
      rpcWithMintOwner(SPL_TOKEN_PROGRAM_ADDRESS),
      altWriter,
    );

    const result = await writer.create(
      deployedCc({
        fee: deployedCcFee(),
        hook: deployedIgpHook(),
        crossCollateralRouters: { 10: new Set([REMOTE_ROUTER_HEX]) },
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

describe('SvmCrossCollateralTokenAltWriter.read', () => {
  it('reads the core ALT and every warp-specific ALT through the injected altWriter', async () => {
    const altWriter = stubAltWriter();
    const coreAlt = frozenAltAt(CORE_ALT_ADDRESS, [WARP_PROGRAM]);
    const warpAlt = frozenAltAt(WARP_ALT_ADDRESS, [MINT]);
    altWriter.read.withArgs(CORE_ALT_ADDRESS).resolves(coreAlt);
    altWriter.read.withArgs(WARP_ALT_ADDRESS).resolves(warpAlt);

    const writer = new SvmCrossCollateralTokenAltWriter(
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

describe('SvmCrossCollateralTokenAltWriter.check', () => {
  async function expectedAddressesFor(
    deployed: ArtifactDeployed<
      CrossCollateralWarpArtifactConfig,
      DeployedWarpAddress
    >,
  ): Promise<{ core: Address[]; warpSpecific: Address[] }> {
    const altWriter = stubAltWriter();
    altWriter.create.resolves([
      frozenAltAt(CORE_ALT_ADDRESS, [WARP_PROGRAM]),
      [],
    ]);
    const writer = new SvmCrossCollateralTokenAltWriter(
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
    const deployed = deployedCc({
      fee: deployedCcFee(),
      hook: deployedIgpHook(),
      crossCollateralRouters: { 10: new Set([REMOTE_ROUTER_HEX]) },
    });
    const expected = await expectedAddressesFor(deployed);

    const altWriter = stubAltWriter();
    altWriter.read
      .withArgs(CORE_ALT_ADDRESS)
      .resolves(frozenAltAt(CORE_ALT_ADDRESS, expected.core));
    altWriter.read
      .withArgs(WARP_ALT_ADDRESS)
      .resolves(frozenAltAt(WARP_ALT_ADDRESS, expected.warpSpecific));
    const writer = new SvmCrossCollateralTokenAltWriter(
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
    const deployed = deployedCc({
      fee: deployedCcFee(),
      hook: deployedIgpHook(),
      crossCollateralRouters: { 10: new Set([REMOTE_ROUTER_HEX]) },
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
    const writer = new SvmCrossCollateralTokenAltWriter(
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
    const deployed = deployedCc();
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
    const writer = new SvmCrossCollateralTokenAltWriter(
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
