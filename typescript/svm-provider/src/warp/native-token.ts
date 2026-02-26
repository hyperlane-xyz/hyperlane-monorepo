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
  type RawNativeWarpArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/warp';
import {
  ZERO_ADDRESS_HEX_32,
  assert,
  isNullish,
  isZeroishAddress,
} from '@hyperlane-xyz/utils';

import { resolveProgram } from '../deploy/resolve-program.js';
import { getTokenInitInstruction } from '../instructions/token.js';
import { writableAccount } from '../instructions/utils.js';
import { deriveNativeCollateralPda } from '../pda.js';
import type { SvmSigner } from '../signer.js';
import type { AnnotatedSvmTransaction, SvmRpc, SvmReceipt } from '../types.js';

import {
  applyPostInitConfig,
  assertLocalDecimals,
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
      type: TokenType.native,
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
      decimals: token.decimals,
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
      true,
    );
    receipts.push(...deployReceipts);

    const { address: nativeCollateralPda } =
      await deriveNativeCollateralPda(programAddress);

    const localDecimals = tokenConfig.decimals ?? SOL_DECIMALS;
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
      [writableAccount(nativeCollateralPda)],
    );

    receipts.push(
      await this.svmSigner.send({
        instructions: [initIx],
        computeUnits: 400_000,
        skipPreflight: true,
      }),
    );

    receipts.push(
      ...(await applyPostInitConfig(
        this.svmSigner,
        programAddress,
        tokenConfig,
      )),
    );

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

    assert(
      !isZeroishAddress(current.config.owner),
      `Cannot update native token ${programId}: token has no owner`,
    );

    return computeWarpTokenUpdateInstructions(
      current.config,
      artifact.config,
      programId,
      parseAddress(current.config.owner),
      this.config.igpProgramId,
      `native token ${programId}`,
    );
  }
}
