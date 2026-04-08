import {
  type Address,
  address as parseAddress,
  fetchEncodedAccount,
} from '@solana/kit';

import {
  type ArtifactDeployed,
  type ArtifactNew,
  type ArtifactReader,
  ArtifactState,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  TokenType,
  type DeployedWarpAddress,
  type RawCrossCollateralWarpArtifactConfig,
  computeCCRouterGasConfigUpdates,
  computeCrossCollateralRouterUpdates,
} from '@hyperlane-xyz/provider-sdk/warp';
import {
  ZERO_ADDRESS_HEX_32,
  assert,
  isNullish,
  isZeroishAddress,
} from '@hyperlane-xyz/utils';

import { decodeCrossCollateralStateAccount } from '../accounts/cross-collateral-token.js';
import { getMintDecimals, fetchMintMetadata } from '../accounts/mint.js';
import { decodeCollateralPlugin } from '../accounts/token.js';
import type { SvmSigner } from '../clients/signer.js';
import {
  DEFAULT_COMPUTE_UNITS,
  RENT_SYSVAR_ADDRESS,
  SPL_TOKEN_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
} from '../constants.js';
import { resolveProgram } from '../deploy/resolve-program.js';
import {
  type CrossCollateralRouterUpdate,
  getCrossCollateralInitInstruction,
  getSetCrossCollateralRoutersInstruction,
} from '../instructions/cross-collateral-token.js';
import { getTokenSetDestinationGasConfigsInstruction } from '../instructions/token.js';
import { readonlyAccount, writableAccount } from '../instructions/utils.js';
import {
  deriveAtaPayerPda,
  deriveCrossCollateralStatePda,
  deriveEscrowPda,
  deriveMailboxOutboxPda,
} from '../pda.js';
import type { AnnotatedSvmTransaction, SvmReceipt, SvmRpc } from '../types.js';

import type { SvmWarpTokenConfig } from './types.js';
import {
  fetchTokenAccount,
  routerBytesToHex,
  routerHexToBytes,
} from './warp-query.js';
import {
  applyPostInitConfig,
  assertLocalDecimals,
  buildBaseInitData,
  buildFundAtaPayerInstruction,
  MAX_GAS_CONFIGS_PER_TX,
  computeWarpTokenUpdateInstructions,
  remoteDecimalsToScale,
  scaleToRemoteDecimals,
} from './warp-tx.js';

const MAX_CC_ROUTERS_PER_TX = 20;

export class SvmCrossCollateralTokenReader implements ArtifactReader<
  RawCrossCollateralWarpArtifactConfig,
  DeployedWarpAddress
> {
  constructor(protected readonly rpc: SvmRpc) {}

  async read(
    programAddress: string,
  ): Promise<
    ArtifactDeployed<RawCrossCollateralWarpArtifactConfig, DeployedWarpAddress>
  > {
    const programId = parseAddress(programAddress);
    const token = await fetchTokenAccount(this.rpc, programId);
    assert(
      !isNullish(token),
      `Cross-collateral token not initialized at ${programId}`,
    );

    const plugin = decodeCollateralPlugin(token.pluginData);

    // Read CC state
    const { address: ccStatePdaAddr } =
      await deriveCrossCollateralStatePda(programId);
    const ccStateAccount = await fetchEncodedAccount(this.rpc, ccStatePdaAddr);
    assert(
      ccStateAccount.exists,
      `Cross-collateral state PDA not found at ${ccStatePdaAddr}`,
    );
    const ccState = decodeCrossCollateralStateAccount(
      Uint8Array.from(ccStateAccount.data),
    );
    assert(
      !isNullish(ccState),
      `Failed to decode cross-collateral state at ${ccStatePdaAddr}`,
    );

    // Build base remote routers
    const remoteRouters: Record<number, { address: string }> = {};
    for (const [domain, router] of token.remoteRouters.entries()) {
      remoteRouters[domain] = { address: routerBytesToHex(router) };
    }

    // Build destination gas
    const destinationGas: Record<number, string> = {};
    for (const [domain, gas] of token.destinationGas.entries()) {
      destinationGas[domain] = gas.toString();
    }

    // Build enrolled routers as Record<number, Set<string>>
    const crossCollateralRouters: Record<number, Set<string>> = {};
    for (const [domain, routerSet] of ccState.enrolledRouters.entries()) {
      crossCollateralRouters[domain] = new Set(routerSet.map(routerBytesToHex));
    }

    const metadata = await fetchMintMetadata(this.rpc, plugin.mint);

    assert(
      token.decimals === metadata.decimals,
      `Decimals mismatch for cross-collateral token ${programId}: ` +
        `warp route initialized with ${token.decimals} but mint reports ${metadata.decimals}`,
    );

    const config: RawCrossCollateralWarpArtifactConfig = {
      type: TokenType.crossCollateral,
      owner: token.owner ?? ZERO_ADDRESS_HEX_32,
      mailbox: token.mailbox,
      token: plugin.mint,
      name: metadata.name,
      symbol: metadata.symbol,
      decimals: token.decimals,
      interchainSecurityModule: token.interchainSecurityModule
        ? {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: token.interchainSecurityModule },
          }
        : undefined,
      hook: token.interchainGasPaymaster
        ? {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: token.interchainGasPaymaster.programId },
          }
        : undefined,
      remoteRouters,
      destinationGas,
      scale: remoteDecimalsToScale(token.decimals, token.remoteDecimals),
      crossCollateralRouters,
    };

    return {
      artifactState: ArtifactState.DEPLOYED,
      config,
      deployed: { address: programId },
    };
  }
}

export async function buildCrossCollateralRouterEnrollTxs(
  programAddress: Address,
  owner: Address,
  crossCollateralRouters: Record<number, Set<string>>,
): Promise<AnnotatedSvmTransaction[]> {
  const updates: CrossCollateralRouterUpdate[] = [];
  for (const [domain, routerSet] of Object.entries(crossCollateralRouters)) {
    for (const routerHex of routerSet) {
      updates.push({
        kind: 'add',
        config: { domain: Number(domain), router: routerHexToBytes(routerHex) },
      });
    }
  }

  const txs: AnnotatedSvmTransaction[] = [];
  const totalBatches = Math.ceil(updates.length / MAX_CC_ROUTERS_PER_TX);
  for (let i = 0; i < updates.length; i += MAX_CC_ROUTERS_PER_TX) {
    const batch = updates.slice(i, i + MAX_CC_ROUTERS_PER_TX);
    const batchNum = i / MAX_CC_ROUTERS_PER_TX + 1;
    txs.push({
      feePayer: owner,
      instructions: [
        await getSetCrossCollateralRoutersInstruction(
          programAddress,
          owner,
          batch,
        ),
      ],
      annotation: `Enroll CC routers${totalBatches > 1 ? ` (${batchNum}/${totalBatches})` : ''}`,
    });
  }

  return txs;
}

export async function buildCrossCollateralRouterUnenrollTxs(
  programAddress: Address,
  owner: Address,
  crossCollateralRouters: Record<number, Set<string> | null>,
): Promise<AnnotatedSvmTransaction[]> {
  const updates: CrossCollateralRouterUpdate[] = [];
  for (const [domain, routerSet] of Object.entries(crossCollateralRouters)) {
    if (routerSet === null) {
      updates.push({
        kind: 'remove',
        config: { domain: Number(domain), router: null },
      });
    } else {
      for (const routerHex of routerSet) {
        updates.push({
          kind: 'remove',
          config: {
            domain: Number(domain),
            router: routerHexToBytes(routerHex),
          },
        });
      }
    }
  }

  const txs: AnnotatedSvmTransaction[] = [];
  const totalBatches = Math.ceil(updates.length / MAX_CC_ROUTERS_PER_TX);
  for (let i = 0; i < updates.length; i += MAX_CC_ROUTERS_PER_TX) {
    const batch = updates.slice(i, i + MAX_CC_ROUTERS_PER_TX);
    const batchNum = i / MAX_CC_ROUTERS_PER_TX + 1;
    txs.push({
      feePayer: owner,
      instructions: [
        await getSetCrossCollateralRoutersInstruction(
          programAddress,
          owner,
          batch,
        ),
      ],
      annotation: `Unenroll CC routers${totalBatches > 1 ? ` (${batchNum}/${totalBatches})` : ''}`,
    });
  }

  return txs;
}

export class SvmCrossCollateralTokenWriter
  extends SvmCrossCollateralTokenReader
  implements
    ArtifactWriter<RawCrossCollateralWarpArtifactConfig, DeployedWarpAddress>
{
  constructor(
    private readonly config: SvmWarpTokenConfig,
    rpc: SvmRpc,
    private readonly svmSigner: SvmSigner,
  ) {
    super(rpc);
  }

  async create(
    artifact: ArtifactNew<RawCrossCollateralWarpArtifactConfig>,
  ): Promise<
    [
      ArtifactDeployed<
        RawCrossCollateralWarpArtifactConfig,
        DeployedWarpAddress
      >,
      SvmReceipt[],
    ]
  > {
    const receipts: SvmReceipt[] = [];
    const tokenConfig = artifact.config;

    // Validate the collateral mint
    const collateralMint = parseAddress(tokenConfig.token);
    const mintAccount = await fetchEncodedAccount(this.rpc, collateralMint);
    assert(mintAccount.exists, `Mint account not found: ${collateralMint}`);
    const splProgram = mintAccount.programAddress;
    assert(
      splProgram === SPL_TOKEN_PROGRAM_ADDRESS ||
        splProgram === TOKEN_2022_PROGRAM_ADDRESS,
      `Mint ${collateralMint} is not owned by SPL Token or Token-2022 (owner: ${splProgram})`,
    );
    const localDecimals = getMintDecimals(Uint8Array.from(mintAccount.data));
    assertLocalDecimals(localDecimals);
    const remoteDecimals = scaleToRemoteDecimals(
      localDecimals,
      tokenConfig.scale,
    );

    // Deploy program
    const { programAddress, receipts: deployReceipts } = await resolveProgram(
      this.config.program,
      this.svmSigner,
      this.rpc,
      true,
    );
    receipts.push(...deployReceipts);

    const { address: escrowPda } = await deriveEscrowPda(programAddress);
    const { address: ataPayerPda } = await deriveAtaPayerPda(programAddress);
    const { address: mailboxOutboxPda } = await deriveMailboxOutboxPda(
      parseAddress(tokenConfig.mailbox),
    );

    const baseInitData = await buildBaseInitData(
      tokenConfig,
      localDecimals,
      remoteDecimals,
    );

    const initIx = await getCrossCollateralInitInstruction(
      programAddress,
      this.svmSigner.signer,
      baseInitData,
      [
        readonlyAccount(splProgram),
        readonlyAccount(collateralMint),
        readonlyAccount(RENT_SYSVAR_ADDRESS),
        writableAccount(escrowPda),
        writableAccount(ataPayerPda),
      ],
      mailboxOutboxPda,
    );

    receipts.push(
      await this.svmSigner.send({
        instructions: [initIx],
        computeUnits: DEFAULT_COMPUTE_UNITS,
        skipPreflight: true,
      }),
    );

    // Fund ATA payer
    const fundAtaPayerIx = await buildFundAtaPayerInstruction(
      this.rpc,
      this.svmSigner.signer.address,
      programAddress,
      this.config.ataPayerFundingAmount,
    );
    if (fundAtaPayerIx) {
      receipts.push(
        await this.svmSigner.send({ instructions: [fundAtaPayerIx] }),
      );
    }

    // Apply standard post-init config (remote routers + destination gas)
    receipts.push(
      ...(await applyPostInitConfig(
        this.svmSigner,
        programAddress,
        tokenConfig,
      )),
    );

    // Enroll CC routers
    if (tokenConfig.crossCollateralRouters) {
      const ccRouterTxs = await buildCrossCollateralRouterEnrollTxs(
        programAddress,
        this.svmSigner.signer.address,
        tokenConfig.crossCollateralRouters,
      );
      for (const tx of ccRouterTxs) {
        receipts.push(await this.svmSigner.send(tx));
      }
    }

    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        config: { ...tokenConfig, decimals: localDecimals },
        deployed: { address: programAddress },
      },
      receipts,
    ];
  }

  async update(
    artifact: ArtifactDeployed<
      RawCrossCollateralWarpArtifactConfig,
      DeployedWarpAddress
    >,
  ): Promise<AnnotatedSvmTransaction[]> {
    const programId = parseAddress(artifact.deployed.address);
    const current = await this.read(programId);

    assert(
      !isZeroishAddress(current.config.owner),
      `Cannot update cross-collateral token ${programId}: token has no owner`,
    );

    const ownerAddress = parseAddress(current.config.owner);

    const currentCCRouters = current.config.crossCollateralRouters ?? {};
    const expectedCCRouters = artifact.config.crossCollateralRouters ?? {};

    const { toEnroll, toUnenroll } = computeCrossCollateralRouterUpdates(
      currentCCRouters,
      expectedCCRouters,
    );

    // CC router updates first (need current owner before any ownership transfer)
    const txs: AnnotatedSvmTransaction[] = [];

    if (Object.keys(toUnenroll).length > 0) {
      txs.push(
        ...(await buildCrossCollateralRouterUnenrollTxs(
          programId,
          ownerAddress,
          toUnenroll,
        )),
      );
    }

    if (Object.keys(toEnroll).length > 0) {
      txs.push(
        ...(await buildCrossCollateralRouterEnrollTxs(
          programId,
          ownerAddress,
          toEnroll,
        )),
      );
    }

    // For domains transitioning from remoteRouter to CC-only, inject their
    // current gas into the expected config so the base diff doesn't unenroll it.
    const expectedWithPreservedGas = preserveGasForCCTransitionDomains(
      current.config,
      artifact.config,
      expectedCCRouters,
    );

    // Base warp token updates (ownership/upgrade auth always last)
    txs.push(
      ...(await computeWarpTokenUpdateInstructions(
        current.config,
        expectedWithPreservedGas,
        programId,
        ownerAddress,
        this.rpc,
        `cross-collateral token ${programId}`,
      )),
    );

    // Gas updates for CC-only domains not covered by computeWarpTokenUpdateInstructions
    // (which only derives its domain set from remoteRouters).
    const expectedRouterDomains = new Set(
      Object.keys(artifact.config.remoteRouters).map(Number),
    );
    const ccGasDiff = computeCCRouterGasConfigUpdates(
      current.config.destinationGas,
      artifact.config.destinationGas,
      expectedRouterDomains,
      currentCCRouters,
      expectedCCRouters,
    );

    txs.push(
      ...(await buildCCGasConfigTxs(ccGasDiff, programId, ownerAddress)),
    );

    return txs;
  }
}

/**
 * For domains transitioning from remoteRouter to CC-only, inject their current
 * gas value into the expected config. This prevents computeWarpTokenUpdateInstructions
 * from emitting a gas unenroll that would be immediately reversed.
 */
function preserveGasForCCTransitionDomains(
  current: RawCrossCollateralWarpArtifactConfig,
  expected: RawCrossCollateralWarpArtifactConfig,
  expectedCCRouters: Record<number, Set<string>>,
): RawCrossCollateralWarpArtifactConfig {
  const currentRouterDomains = new Set(
    Object.keys(current.remoteRouters).map(Number),
  );
  const expectedRouterDomains = new Set(
    Object.keys(expected.remoteRouters).map(Number),
  );

  const preservedGas: Record<number, string> = {};
  for (const domain of currentRouterDomains) {
    if (expectedRouterDomains.has(domain)) continue;
    const hasCCRouters =
      expectedCCRouters[domain] && expectedCCRouters[domain].size > 0;
    const currentGas = current.destinationGas[domain];
    if (hasCCRouters && currentGas) {
      preservedGas[domain] = currentGas;
    }
  }

  if (Object.keys(preservedGas).length === 0) return expected;

  return {
    ...expected,
    destinationGas: { ...expected.destinationGas, ...preservedGas },
  };
}

async function buildCCGasConfigTxs(
  diff: {
    toEnroll: Array<{ domain: number; gas: string }>;
    toUnenroll: number[];
  },
  programId: Address,
  ownerAddress: Address,
): Promise<AnnotatedSvmTransaction[]> {
  const txs: AnnotatedSvmTransaction[] = [];

  for (let i = 0; i < diff.toUnenroll.length; i += MAX_GAS_CONFIGS_PER_TX) {
    const batch = diff.toUnenroll.slice(i, i + MAX_GAS_CONFIGS_PER_TX);
    txs.push({
      feePayer: ownerAddress,
      instructions: [
        await getTokenSetDestinationGasConfigsInstruction(
          programId,
          ownerAddress,
          batch.map((domain) => ({ domain, gas: null })),
        ),
      ],
      annotation: `Unenroll CC-only gas configs`,
    });
  }

  for (let i = 0; i < diff.toEnroll.length; i += MAX_GAS_CONFIGS_PER_TX) {
    const batch = diff.toEnroll.slice(i, i + MAX_GAS_CONFIGS_PER_TX);
    txs.push({
      feePayer: ownerAddress,
      instructions: [
        await getTokenSetDestinationGasConfigsInstruction(
          programId,
          ownerAddress,
          batch.map((e) => ({ domain: e.domain, gas: BigInt(e.gas) })),
        ),
      ],
      annotation: `Enroll CC-only gas configs`,
    });
  }

  return txs;
}
