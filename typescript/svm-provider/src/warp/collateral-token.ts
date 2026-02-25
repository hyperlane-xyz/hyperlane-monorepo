import { address as parseAddress } from '@solana/kit';

import {
  type ArtifactDeployed,
  type ArtifactNew,
  type ArtifactReader,
  ArtifactState,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import type {
  DeployedWarpAddress,
  RawCollateralWarpArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/warp';
import { ZERO_ADDRESS_HEX_32, assert, isNullish } from '@hyperlane-xyz/utils';

import { resolveProgram } from '../deploy/resolve-program.js';
import { RENT_SYSVAR_ADDRESS, SYSTEM_PROGRAM_ADDRESS } from '../constants.js';
import { decodeCollateralPlugin } from '../accounts/token.js';
import { fetchMintMetadata, getMintDecimals } from '../accounts/mint.js';
import { encodeTokenProgramInstruction } from '../instructions/token.js';
import {
  buildInstruction,
  readonlyAccount,
  writableAccount,
  writableSigner,
} from '../instructions/utils.js';
import {
  deriveAtaPayerPda,
  deriveEscrowPda,
  deriveHyperlaneTokenPda,
  deriveMailboxDispatchAuthorityPda,
} from '../pda.js';
import type { SvmSigner } from '../signer.js';
import type { AnnotatedSvmTransaction, SvmRpc, SvmReceipt } from '../types.js';

import {
  applyPostInitConfig,
  buildBaseInitData,
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

    const config: RawCollateralWarpArtifactConfig = {
      type: 'collateral',
      owner: token.owner ?? ZERO_ADDRESS_HEX_32,
      mailbox: token.mailbox,
      token: plugin.mint,
      name: metadata.name,
      symbol: metadata.symbol,
      decimals: metadata.decimals,
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
      // token.decimals holds the local decimals stored at init time.
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
    );
    receipts.push(...deployReceipts);

    const { address: tokenPda } = await deriveHyperlaneTokenPda(programAddress);
    const { address: dispatchAuthPda } =
      await deriveMailboxDispatchAuthorityPda(programAddress);
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

    const initData = buildBaseInitData(
      tokenConfig,
      this.config.igpProgramId,
      localDecimals,
      scaleToRemoteDecimals(localDecimals, tokenConfig.scale),
    );

    const initIx = buildInstruction(
      programAddress,
      [
        readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
        writableAccount(tokenPda),
        writableAccount(dispatchAuthPda),
        writableSigner(this.svmSigner.signer),
        readonlyAccount(splProgram),
        readonlyAccount(collateralMint),
        readonlyAccount(RENT_SYSVAR_ADDRESS),
        writableAccount(escrowPda),
        writableAccount(ataPayerPda),
      ],
      encodeTokenProgramInstruction({ kind: 'init', value: initData }),
    );

    receipts.push(
      await this.svmSigner.send({
        instructions: [initIx],
        computeUnits: 400_000,
        skipPreflight: true,
      }),
    );

    await new Promise((r) => setTimeout(r, 2000));

    const check = await fetchTokenAccount(this.rpc, programAddress);
    if (!check) {
      throw new Error(
        `Init failed - token account not found at ${programAddress}`,
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

    const instructions = await computeWarpTokenUpdateInstructions(
      current.config,
      artifact.config,
      programId,
      this.svmSigner.signer,
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
