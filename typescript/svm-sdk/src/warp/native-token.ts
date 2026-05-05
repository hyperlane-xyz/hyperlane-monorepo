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
  type RawNativeWarpArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/warp';
import {
  ZERO_ADDRESS_HEX_32,
  assert,
  isNullish,
  isZeroishAddress,
} from '@hyperlane-xyz/utils';

import type { SvmSigner } from '../clients/signer.js';
import { resolveProgram } from '../deploy/resolve-program.js';
import { getTokenInitInstruction } from '../instructions/token.js';
import { writableAccount } from '../instructions/utils.js';
import { deriveNativeCollateralPda } from '../pda.js';
import type { AnnotatedSvmTransaction, SvmReceipt, SvmRpc } from '../types.js';

import type { SvmDeployedWarpAddress, SvmWarpTokenConfig } from './types.js';
import { prepareProgramUpgrade } from './warp-upgrade.js';
import {
  fetchNativeTokenAccount,
  fetchWarpProgramVersion,
  routerBytesToHex,
} from './warp-query.js';
import {
  applyPostInitConfig,
  assertLocalDecimals,
  buildBaseInitData,
  computeWarpTokenUpdateInstructions,
  remoteDecimalsToScale,
  scaleToRemoteDecimals,
} from './warp-tx.js';
import { DEFAULT_COMPUTE_UNITS } from '../constants.js';

/** Native SOL decimal precision. */
const SOL_DECIMALS = 9;

export class SvmNativeTokenReader implements ArtifactReader<
  RawNativeWarpArtifactConfig,
  SvmDeployedWarpAddress
> {
  constructor(protected readonly rpc: SvmRpc) {}

  async read(
    programAddress: string,
  ): Promise<
    ArtifactDeployed<RawNativeWarpArtifactConfig, SvmDeployedWarpAddress>
  > {
    const programId = parseAddress(programAddress);
    const token = await fetchNativeTokenAccount(this.rpc, programId);
    assert(!isNullish(token), `Native token not initialized at ${programId}`);

    const remoteRouters: Record<number, { address: string }> = {};
    for (const [domain, router] of token.remoteRouters.entries()) {
      remoteRouters[domain] = { address: routerBytesToHex(router) };
    }

    const destinationGas: Record<number, string> = {};
    for (const [domain, gas] of token.destinationGas.entries()) {
      destinationGas[domain] = gas.toString();
    }

    const contractVersion = await fetchWarpProgramVersion(
      this.rpc,
      programId,
      token.owner,
    );

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
            deployed: { address: token.interchainGasPaymaster.programId },
          }
        : undefined,
      remoteRouters,
      destinationGas,
      decimals: token.decimals,
      scale: remoteDecimalsToScale(token.decimals, token.remoteDecimals),
      contractVersion: contractVersion ?? undefined,
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

export class SvmNativeTokenWriter
  extends SvmNativeTokenReader
  implements ArtifactWriter<RawNativeWarpArtifactConfig, SvmDeployedWarpAddress>
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
      ArtifactDeployed<RawNativeWarpArtifactConfig, SvmDeployedWarpAddress>,
      SvmReceipt[],
    ]
  > {
    const receipts: SvmReceipt[] = [];
    const tokenConfig = artifact.config;

    const localDecimals = tokenConfig.decimals ?? SOL_DECIMALS;
    assertLocalDecimals(localDecimals);
    const remoteDecimals = scaleToRemoteDecimals(
      localDecimals,
      tokenConfig.scale,
    );

    const { programAddress, receipts: deployReceipts } = await resolveProgram(
      this.config.program,
      this.svmSigner,
      this.rpc,
      true,
    );
    receipts.push(...deployReceipts);

    const { address: nativeCollateralPda } =
      await deriveNativeCollateralPda(programAddress);

    const initData = await buildBaseInitData(
      tokenConfig,
      localDecimals,
      remoteDecimals,
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
        computeUnits: DEFAULT_COMPUTE_UNITS,
        skipPreflight: true,
      }),
    );

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
      RawNativeWarpArtifactConfig,
      SvmDeployedWarpAddress
    >,
  ): Promise<AnnotatedSvmTransaction[]> {
    const programId = parseAddress(artifact.deployed.address);
    const current = await this.read(programId);

    assert(
      !isZeroishAddress(current.config.owner),
      `Cannot update native token ${programId}: token has no owner`,
    );

    const txs: AnnotatedSvmTransaction[] = [];

    if ('programBytes' in this.config.program) {
      const upgradeResult = await prepareProgramUpgrade(
        programId,
        current.config.contractVersion,
        artifact.config.contractVersion,
        this.config.program.programBytes,
        this.svmSigner,
        this.rpc,
        `native token ${programId}`,
      );
      txs.push(...(upgradeResult?.authorityTransactions ?? []));
    }

    const configUpdateTxs = await computeWarpTokenUpdateInstructions(
      current.config,
      artifact.config,
      programId,
      parseAddress(current.config.owner),
      this.rpc,
      `native token ${programId}`,
      this.config.feeSalt,
      current.deployed.feeConfig,
    );
    txs.push(...configUpdateTxs);

    return txs;
  }
}
