import { address as parseAddress } from '@solana/kit';

import {
  type ArtifactDeployed,
  type ArtifactNew,
  ArtifactComposition,
  ArtifactState,
  type WithCompositionVariant,
  type ArtifactReader,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  TokenType,
  type RawCollateralWarpArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/warp';
import {
  ZERO_ADDRESS_HEX_32,
  assert,
  isNullish,
  isZeroishAddress,
} from '@hyperlane-xyz/utils';

import { fetchMintMetadata, getMintDecimals } from '../accounts/mint.js';
import { decodeCollateralPlugin } from '../accounts/token.js';
import type { SvmSigner } from '../clients/signer.js';
import {
  DEFAULT_COMPUTE_UNITS,
  RENT_SYSVAR_ADDRESS,
  SPL_TOKEN_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
} from '../constants.js';
import { prepareProgramUpgrade } from '../deploy/program-upgrade.js';
import { resolveProgram } from '../deploy/resolve-program.js';
import { getTokenInitInstruction } from '../instructions/token.js';
import { readonlyAccount, writableAccount } from '../instructions/utils.js';
import { deriveAtaPayerPda, deriveEscrowPda } from '../pda.js';
import { hasProgramBytes } from '../types.js';
import type { AnnotatedSvmTransaction, SvmReceipt, SvmRpc } from '../types.js';

import type { SvmDeployedWarpAddress, SvmWarpTokenConfig } from './types.js';
import {
  fetchCollateralTokenAccount,
  fetchWarpProgramVersion,
  routerBytesToHex,
} from './warp-query.js';
import {
  applyPostInitConfig,
  assertLocalDecimals,
  buildBaseInitData,
  buildFundAtaPayerInstruction,
  computeWarpTokenUpdateInstructions,
  remoteDecimalsToScale,
  scaleToRemoteDecimals,
} from './warp-tx.js';

type OrchestratedRawCollateralWarpArtifactConfig = WithCompositionVariant<
  RawCollateralWarpArtifactConfig,
  typeof ArtifactComposition.ORCHESTRATED
>;

export class SvmCollateralTokenReader implements ArtifactReader<
  RawCollateralWarpArtifactConfig,
  SvmDeployedWarpAddress
> {
  readonly composition = ArtifactComposition.ORCHESTRATED;

  constructor(protected readonly rpc: SvmRpc) {}

  async read(
    programAddress: string,
  ): Promise<
    ArtifactDeployed<
      OrchestratedRawCollateralWarpArtifactConfig,
      SvmDeployedWarpAddress
    >
  > {
    const programId = parseAddress(programAddress);
    const token = await fetchCollateralTokenAccount(this.rpc, programId);
    assert(
      !isNullish(token),
      `Collateral token not initialized at ${programId}`,
    );

    const plugin = decodeCollateralPlugin(token.pluginData);

    const remoteRouters: Record<number, { address: string }> = {};
    for (const [domain, router] of token.remoteRouters.entries()) {
      remoteRouters[domain] = { address: routerBytesToHex(router) };
    }

    const destinationGas: Record<number, string> = {};
    for (const [domain, gas] of token.destinationGas.entries()) {
      destinationGas[domain] = gas.toString();
    }

    const metadata = await fetchMintMetadata(this.rpc, plugin.mint);

    assert(
      token.decimals === metadata.decimals,
      `Decimals mismatch for collateral token ${programId}: ` +
        `warp route initialized with ${token.decimals} but mint reports ${metadata.decimals}`,
    );

    const contractVersion = await fetchWarpProgramVersion(
      this.rpc,
      programId,
      token.owner,
    );

    const config: OrchestratedRawCollateralWarpArtifactConfig = {
      composition: ArtifactComposition.ORCHESTRATED,
      type: TokenType.collateral,
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
      contractVersion: contractVersion ?? undefined,
      fee: token.feeConfig
        ? {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: token.feeConfig.feeProgram },
          }
        : undefined,
    };

    return {
      artifactState: ArtifactState.DEPLOYED,
      config,
      deployed: {
        address: programId,
        feeConfig: token.feeConfig ?? undefined,
      },
    };
  }
}

export class SvmCollateralTokenWriter
  extends SvmCollateralTokenReader
  implements
    ArtifactWriter<RawCollateralWarpArtifactConfig, SvmDeployedWarpAddress>
{
  constructor(
    private readonly config: SvmWarpTokenConfig,
    rpc: SvmRpc,
    private readonly svmSigner: SvmSigner,
  ) {
    super(rpc);
  }

  async create(
    artifact: ArtifactNew<OrchestratedRawCollateralWarpArtifactConfig>,
  ): Promise<
    [
      ArtifactDeployed<
        OrchestratedRawCollateralWarpArtifactConfig,
        SvmDeployedWarpAddress
      >,
      SvmReceipt[],
    ]
  > {
    const receipts: SvmReceipt[] = [];
    const tokenConfig = artifact.config;

    // Validate the collateral mint before deploying
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
    const mintRawData = Buffer.from(mintInfo.value.data[0], 'base64');
    const localDecimals = getMintDecimals(mintRawData);
    assertLocalDecimals(localDecimals);
    const remoteDecimals = scaleToRemoteDecimals(
      localDecimals,
      tokenConfig.scale,
    );

    // Deploy
    const { programAddress, receipts: deployReceipts } = await resolveProgram(
      this.config.program,
      this.svmSigner,
      this.rpc,
      true,
    );
    receipts.push(...deployReceipts);

    const { address: escrowPda } = await deriveEscrowPda(programAddress);
    const { address: ataPayerPda } = await deriveAtaPayerPda(programAddress);

    const initData = await buildBaseInitData(
      tokenConfig,
      localDecimals,
      remoteDecimals,
    );

    const initIx = await getTokenInitInstruction(
      programAddress,
      this.svmSigner.signer,
      initData,
      [
        readonlyAccount(splProgram),
        readonlyAccount(collateralMint),
        readonlyAccount(RENT_SYSVAR_ADDRESS),
        writableAccount(escrowPda),
        writableAccount(ataPayerPda),
      ],
    );

    receipts.push(
      await this.svmSigner.send({
        instructions: [initIx],
        computeUnits: DEFAULT_COMPUTE_UNITS,
        skipPreflight: true,
      }),
    );

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

    receipts.push(
      ...(await applyPostInitConfig(
        this.svmSigner,
        programAddress,
        tokenConfig,
        this.config.feeSalt,
      )),
    );

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
      OrchestratedRawCollateralWarpArtifactConfig,
      SvmDeployedWarpAddress
    >,
  ): Promise<AnnotatedSvmTransaction[]> {
    const programId = parseAddress(artifact.deployed.address);
    const current = await this.read(programId);

    assert(
      !isZeroishAddress(current.config.owner),
      `Cannot update collateral token ${programId}: token has no owner`,
    );

    const txs: AnnotatedSvmTransaction[] = [];

    let upgradingToVersion: string | undefined;
    if (hasProgramBytes(this.config.program)) {
      const upgradeResult = await prepareProgramUpgrade(
        programId,
        current.config.contractVersion,
        artifact.config.contractVersion,
        this.config.program.programBytes,
        this.svmSigner,
        this.rpc,
        `collateral token ${programId}`,
      );
      txs.push(...(upgradeResult?.authorityTransactions ?? []));
      upgradingToVersion = upgradeResult?.authorityTransactions
        ? artifact.config.contractVersion
        : undefined;
    }

    const configUpdateTxs = await computeWarpTokenUpdateInstructions(
      current.config,
      artifact.config,
      programId,
      parseAddress(current.config.owner),
      this.rpc,
      `collateral token ${programId}`,
      this.config.feeSalt,
      current.deployed.feeConfig,
      upgradingToVersion,
    );
    txs.push(...configUpdateTxs);

    return txs;
  }
}
