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
  RawNativeWarpArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/warp';
import { ZERO_ADDRESS_HEX_32, assert, isNullish } from '@hyperlane-xyz/utils';

import { resolveProgram } from '../deploy/resolve-program.js';
import { SYSTEM_PROGRAM_ADDRESS } from '../constants.js';
import { encodeTokenProgramInstruction } from '../instructions/token.js';
import {
  buildInstruction,
  readonlyAccount,
  writableAccount,
  writableSigner,
} from '../instructions/utils.js';
import {
  deriveHyperlaneTokenPda,
  deriveMailboxDispatchAuthorityPda,
  deriveNativeCollateralPda,
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

/** Native SOL decimal precision. */
const SOL_DECIMALS = 9;

export class SvmNativeTokenReader implements ArtifactReader<
  RawNativeWarpArtifactConfig,
  DeployedWarpAddress
> {
  constructor(protected readonly rpc: SvmRpc) {}

  async read(
    programAddress: string,
  ): Promise<
    ArtifactDeployed<RawNativeWarpArtifactConfig, DeployedWarpAddress>
  > {
    const programId = parseAddress(programAddress);
    const token = await fetchTokenAccount(this.rpc, programId);
    assert(!isNullish(token), `Native token not initialized at ${programId}`);

    const remoteRouters: Record<number, { address: string }> = {};
    for (const [domain, router] of token.remoteRouters.entries()) {
      remoteRouters[domain] = { address: routerBytesToHex(router) };
    }

    const destinationGas: Record<number, string> = {};
    for (const [domain, gas] of token.destinationGas.entries()) {
      destinationGas[domain] = gas.toString();
    }

    const config: RawNativeWarpArtifactConfig = {
      type: 'native',
      owner: token.owner ?? ZERO_ADDRESS_HEX_32,
      mailbox: token.mailbox,
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

export class SvmNativeTokenWriter
  extends SvmNativeTokenReader
  implements ArtifactWriter<RawNativeWarpArtifactConfig, DeployedWarpAddress>
{
  constructor(
    private readonly config: SvmWarpTokenConfig,
    rpc: SvmRpc,
    private readonly svmSigner: SvmSigner,
  ) {
    super(rpc);
  }

  async create(
    artifact: ArtifactNew<RawNativeWarpArtifactConfig>,
  ): Promise<
    [
      ArtifactDeployed<RawNativeWarpArtifactConfig, DeployedWarpAddress>,
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
    const { address: nativeCollateralPda } =
      await deriveNativeCollateralPda(programAddress);

    const initData = buildBaseInitData(
      tokenConfig,
      this.config.igpProgramId,
      SOL_DECIMALS,
      scaleToRemoteDecimals(SOL_DECIMALS, tokenConfig.scale),
    );

    // Build init instruction manually to include the native-collateral PDA
    // and ensure payer is WRITABLE_SIGNER (funds collateral account creation).
    const initIx = buildInstruction(
      programAddress,
      [
        readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
        writableAccount(tokenPda),
        writableAccount(dispatchAuthPda),
        writableSigner(this.svmSigner.signer),
        writableAccount(nativeCollateralPda),
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

    // Wait for account creation to propagate.
    await new Promise((r) => setTimeout(r, 2000));

    const check = await fetchTokenAccount(this.rpc, programAddress);
    if (!check) {
      throw new Error(
        `Init failed — token account not found at ${programAddress}`,
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
      RawNativeWarpArtifactConfig,
      DeployedWarpAddress
    >,
  ): Promise<AnnotatedSvmTransaction[]> {
    const programId = parseAddress(artifact.deployed.address);
    const current = await this.read(programId);

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
        annotation: `Update native token ${programId}`,
      },
    ];
  }
}
