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
} from '@hyperlane-xyz/provider-sdk/warp';
import { ZERO_ADDRESS_HEX_32, assert, isNullish } from '@hyperlane-xyz/utils';

import { decodeCrossCollateralStateAccount } from '../accounts/cross-collateral-token.js';
import { getMintDecimals, fetchMintMetadata } from '../accounts/mint.js';
import { decodeCollateralPlugin } from '../accounts/token.js';
import type { SvmSigner } from '../clients/signer.js';
import {
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
      ccStateAccount.data as Uint8Array,
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
        domain: parseInt(domain),
        router: routerHexToBytes(routerHex),
      });
    }
  }

  const txs: AnnotatedSvmTransaction[] = [];
  const totalBatches = Math.ceil(updates.length / MAX_CC_ROUTERS_PER_TX);
  for (let i = 0; i < updates.length; i += MAX_CC_ROUTERS_PER_TX) {
    const batch = updates.slice(i, i + MAX_CC_ROUTERS_PER_TX);
    const batchNum = i / MAX_CC_ROUTERS_PER_TX + 1;
    txs.push({
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
        config: { domain: parseInt(domain), router: null },
      });
    } else {
      for (const routerHex of routerSet) {
        updates.push({
          kind: 'remove',
          config: { domain: parseInt(domain), router: routerHexToBytes(routerHex) },
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
    const mintInfo = await this.rpc
      .getAccountInfo(collateralMint, { encoding: 'base64' })
      .send();
    assert(
      !isNullish(mintInfo.value),
      `Mint account not found: ${collateralMint}`,
    );
    const splProgram = parseAddress(mintInfo.value.owner);
    assert(
      splProgram === SPL_TOKEN_PROGRAM_ADDRESS ||
        splProgram === TOKEN_2022_PROGRAM_ADDRESS,
      `Mint ${collateralMint} is not owned by SPL Token or Token-2022 (owner: ${splProgram})`,
    );
    const mintRawData = Buffer.from(mintInfo.value.data[0] as string, 'base64');
    const localDecimals = getMintDecimals(mintRawData);
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
        computeUnits: 400_000,
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
    _artifact: ArtifactDeployed<
      RawCrossCollateralWarpArtifactConfig,
      DeployedWarpAddress
    >,
  ): Promise<AnnotatedSvmTransaction[]> {
    throw new Error('Cross-collateral token update not yet implemented');
  }
}
