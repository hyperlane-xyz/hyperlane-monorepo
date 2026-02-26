import { address as parseAddress } from '@solana/kit';

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
  type RawCollateralWarpArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/warp';
import {
  ZERO_ADDRESS_HEX_32,
  assert,
  isNullish,
  isZeroishAddress,
} from '@hyperlane-xyz/utils';

import { resolveProgram } from '../deploy/resolve-program.js';
import { RENT_SYSVAR_ADDRESS } from '../constants.js';
import { decodeCollateralPlugin } from '../accounts/token.js';
import { fetchMintMetadata, getMintDecimals } from '../accounts/mint.js';
import { getTokenInitInstruction } from '../instructions/token.js';
import { readonlyAccount, writableAccount } from '../instructions/utils.js';
import { deriveAtaPayerPda, deriveEscrowPda } from '../pda.js';
import type { SvmSigner } from '../signer.js';
import type { AnnotatedSvmTransaction, SvmRpc, SvmReceipt } from '../types.js';

import {
  applyPostInitConfig,
  assertLocalDecimals,
  buildBaseInitData,
  buildFundAtaPayerInstruction,
  computeWarpTokenUpdateInstructions,
  remoteDecimalsToScale,
  scaleToRemoteDecimals,
} from './warp-tx.js';
import { fetchTokenAccount, routerBytesToHex } from './warp-query.js';
import type { SvmWarpTokenConfig } from './types.js';

export class SvmCollateralTokenReader implements ArtifactReader<
  RawCollateralWarpArtifactConfig,
  DeployedWarpAddress
> {
  constructor(protected readonly rpc: SvmRpc) {}

  async read(
    programAddress: string,
  ): Promise<
    ArtifactDeployed<RawCollateralWarpArtifactConfig, DeployedWarpAddress>
  > {
    const programId = parseAddress(programAddress);
    const token = await fetchTokenAccount(this.rpc, programId);
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

    const config: RawCollateralWarpArtifactConfig = {
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
            deployed: { address: token.interchainGasPaymaster.igpType.account },
          }
        : undefined,
      remoteRouters,
      destinationGas,
      scale: remoteDecimalsToScale(token.decimals, token.remoteDecimals),
    };

    return {
      artifactState: ArtifactState.DEPLOYED,
      config,
      deployed: { address: programId },
    };
  }
}

export class SvmCollateralTokenWriter
  extends SvmCollateralTokenReader
  implements
    ArtifactWriter<RawCollateralWarpArtifactConfig, DeployedWarpAddress>
{
  constructor(
    private readonly config: SvmWarpTokenConfig,
    rpc: SvmRpc,
    private readonly svmSigner: SvmSigner,
  ) {
    super(rpc);
  }

  async create(
    artifact: ArtifactNew<RawCollateralWarpArtifactConfig>,
  ): Promise<
    [
      ArtifactDeployed<RawCollateralWarpArtifactConfig, DeployedWarpAddress>,
      SvmReceipt[],
    ]
  > {
    const receipts: SvmReceipt[] = [];
    const tokenConfig = artifact.config;

    const { programAddress, receipts: deployReceipts } = await resolveProgram(
      this.config.program,
      this.svmSigner,
      this.rpc,
      true,
    );
    receipts.push(...deployReceipts);

    const { address: escrowPda } = await deriveEscrowPda(programAddress);
    const { address: ataPayerPda } = await deriveAtaPayerPda(programAddress);

    // Determine which SPL program owns the mint (Token or Token 2022).
    const collateralMint = parseAddress(tokenConfig.token);
    const mintInfo = await this.rpc
      .getAccountInfo(collateralMint, { encoding: 'base64' })
      .send();
    assert(
      !isNullish(mintInfo.value),
      `Mint account not found: ${collateralMint}`,
    );
    const splProgram = parseAddress(mintInfo.value.owner);
    const mintRawData = Buffer.from(mintInfo.value.data[0] as string, 'base64');
    const localDecimals = getMintDecimals(mintRawData);
    assertLocalDecimals(localDecimals);

    const initData = buildBaseInitData(
      tokenConfig,
      this.config.igpProgramId,
      localDecimals,
      scaleToRemoteDecimals(localDecimals, tokenConfig.scale),
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
        computeUnits: 400_000,
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

    const configReceipt = await applyPostInitConfig(
      this.svmSigner,
      programAddress,
      tokenConfig,
    );
    if (configReceipt) receipts.push(configReceipt);

    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        config: tokenConfig,
        deployed: { address: programAddress },
      },
      receipts,
    ];
  }

  async update(
    artifact: ArtifactDeployed<
      RawCollateralWarpArtifactConfig,
      DeployedWarpAddress
    >,
  ): Promise<AnnotatedSvmTransaction[]> {
    const programId = parseAddress(artifact.deployed.address);
    const current = await this.read(programId);

    assert(
      !isZeroishAddress(current.config.owner),
      `Cannot update collateral token ${programId}: token has no owner`,
    );

    const instructions = await computeWarpTokenUpdateInstructions(
      current.config,
      artifact.config,
      programId,
      parseAddress(current.config.owner),
      this.config.igpProgramId,
    );

    if (instructions.length === 0) return [];

    return [
      {
        instructions,
        annotation: `Update collateral token ${programId}`,
      },
    ];
  }
}
