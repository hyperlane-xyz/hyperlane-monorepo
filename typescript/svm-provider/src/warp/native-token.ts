import {
  AccountRole,
  type Address,
  type Rpc,
  type SolanaRpcApi,
  address,
} from '@solana/kit';

import {
  type ArtifactDeployed,
  type ArtifactNew,
  type ArtifactReader,
  ArtifactState,
  type ArtifactUnderived,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import type {
  DeployedWarpAddress,
  RawNativeWarpArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/warp';
import { ZERO_ADDRESS_HEX_32, assert, isNullish } from '@hyperlane-xyz/utils';

import { deployProgram } from '../deploy/program-deployer.js';
import {
  type InitProxyArgs,
  getTokenInstructionProxyEncoder,
} from '../generated/types/index.js';
import type { SvmSigner } from '../signer.js';
import type {
  AnnotatedSvmTransaction,
  SvmInstruction,
  SvmReceipt,
} from '../types.js';

import {
  SOL_DECIMALS,
  SYSTEM_PROGRAM_ID,
  prependDiscriminator,
} from './constants.js';
import { SvmWarpTokenConfig } from './types.js';
import {
  fetchNativeToken,
  getDispatchAuthorityPda,
  getHyperlaneTokenPda,
  getNativeCollateralPda,
  routerBytesToHex,
} from './warp-query.js';
import {
  applyPostInitConfig,
  buildBaseInitArgs,
  computeWarpTokenUpdateInstructions,
} from './warp-tx.js';

function buildNativeTokenInitInstruction(
  programId: Address,
  payer: Address,
  tokenPda: Address,
  dispatchAuthPda: Address,
  nativeCollateralPda: Address,
  initArgs: InitProxyArgs,
): SvmInstruction {
  const encoder = getTokenInstructionProxyEncoder();
  const data = prependDiscriminator(
    encoder.encode({ __kind: 'Init', fields: [initArgs] }),
  );
  return {
    programAddress: programId,
    accounts: [
      { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY },
      { address: tokenPda, role: AccountRole.WRITABLE },
      { address: dispatchAuthPda, role: AccountRole.WRITABLE },
      { address: payer, role: AccountRole.WRITABLE_SIGNER },
      { address: nativeCollateralPda, role: AccountRole.WRITABLE },
    ],
    data,
  };
}

/**
 * Reader for native warp tokens.
 */
export class SvmNativeTokenReader
  implements ArtifactReader<RawNativeWarpArtifactConfig, DeployedWarpAddress>
{
  constructor(protected readonly rpc: Rpc<SolanaRpcApi>) {}

  async read(
    programAddress: string,
  ): Promise<
    ArtifactDeployed<RawNativeWarpArtifactConfig, DeployedWarpAddress>
  > {
    const programId = address(programAddress);
    const token = await fetchNativeToken(this.rpc, programId);
    assert(!isNullish(token), `Native token not initialized at ${programId}`);

    const remoteRouters: Record<number, { address: string }> = {};
    for (const [domain, router] of token.remoteRouters.entries()) {
      remoteRouters[domain] = { address: routerBytesToHex(router) };
    }

    const destinationGas: Record<number, string> = {};
    for (const [domain, gas] of token.destinationGas.entries()) {
      destinationGas[domain] = gas.toString();
    }

    const igpHook: ArtifactUnderived<{ address: string }> | undefined =
      token.interchainGasPaymaster
        ? {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: token.interchainGasPaymaster[1].fields[0] },
          }
        : undefined;

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
      hook: igpHook,
      remoteRouters,
      destinationGas,
    };

    return {
      artifactState: ArtifactState.DEPLOYED,
      config,
      deployed: { address: programId },
    };
  }
}

/**
 * Writer for native warp tokens.
 * Handles complete deployment: program + initialization + configuration.
 */
export class SvmNativeTokenWriter
  extends SvmNativeTokenReader
  implements ArtifactWriter<RawNativeWarpArtifactConfig, DeployedWarpAddress>
{
  constructor(
    private readonly config: SvmWarpTokenConfig,
    rpc: Rpc<SolanaRpcApi>,
    private readonly signer: SvmSigner,
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
    const config = artifact.config;

    // Step 1: Deploy program
    const deployResult = await deployProgram({
      rpc: this.rpc,
      signer: this.signer,
      programBytes: this.config.programBytes,
    });

    const programId = deployResult.programId;
    receipts.push(...deployResult.receipts);

    // Step 2: Derive PDAs
    const [tokenPda] = await getHyperlaneTokenPda(programId);
    const [dispatchAuthPda] = await getDispatchAuthorityPda(programId);
    const [nativeCollateralPda] = await getNativeCollateralPda(programId);

    // Step 3: Initialize
    const initArgs = buildBaseInitArgs(
      config,
      this.config.igpProgramId,
      SOL_DECIMALS,
      SOL_DECIMALS,
    );

    const initIx = buildNativeTokenInitInstruction(
      programId,
      this.signer.address,
      tokenPda,
      dispatchAuthPda,
      nativeCollateralPda,
      initArgs,
    );

    const initReceipt = await this.signer.signAndSend(this.rpc, {
      instructions: [initIx],
      computeUnits: 400_000,
    });
    receipts.push(initReceipt);

    // Wait for account creation
    await new Promise((r) => setTimeout(r, 2000));

    const rawAccount = await this.rpc
      .getAccountInfo(tokenPda, { encoding: 'base64' })
      .send();

    if (!rawAccount.value) {
      throw new Error(`Init failed - no account created at ${tokenPda}`);
    }

    // Step 4: Configure routers, gas, ISM
    const configReceipt = await applyPostInitConfig(
      this.rpc,
      this.signer,
      programId,
      config,
    );
    if (configReceipt) receipts.push(configReceipt);

    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        config,
        deployed: { address: programId },
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
    const programId = address(artifact.deployed.address);
    const current = await this.read(programId);

    const instructions = await computeWarpTokenUpdateInstructions(
      current.config,
      artifact.config,
      programId,
      this.signer.address,
      this.config.igpProgramId,
    );

    if (instructions.length === 0) {
      return [];
    }

    return [
      {
        instructions,
        annotation: `Update native token ${programId}`,
      },
    ];
  }
}
