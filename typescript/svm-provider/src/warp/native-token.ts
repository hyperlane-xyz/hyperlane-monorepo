import { type Address, type Rpc, type SolanaRpcApi } from '@solana/kit';

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
import { assert } from '@hyperlane-xyz/utils';

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
  fetchNativeToken,
  getDispatchAuthorityPda,
  getHyperlaneTokenPda,
  getNativeCollateralPda,
  routerBytesToHex,
} from './warp-query.js';
import {
  type DestinationGasConfig,
  type RouterEnrollment,
  computeWarpTokenUpdateInstructions,
  getEnrollRemoteRoutersIx,
  getSetDestinationGasConfigsIx,
  getSetIsmIx,
} from './warp-tx.js';

const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111' as Address;

/**
 * Builds Init instruction for native token.
 */
/**
 * Program instruction discriminator used by Hyperlane token programs.
 * From Rust: PROGRAM_INSTRUCTION_DISCRIMINATOR = [1,1,1,1,1,1,1,1]
 */
const PROGRAM_INSTRUCTION_DISCRIMINATOR = new Uint8Array([
  1, 1, 1, 1, 1, 1, 1, 1,
]);

function buildNativeTokenInitInstruction(
  programId: Address,
  payer: Address,
  tokenPda: Address,
  dispatchAuthPda: Address,
  nativeCollateralPda: Address,
  initArgs: InitProxyArgs,
): SvmInstruction {
  // Encode as TokenInstructionProxy enum
  const encoder = getTokenInstructionProxyEncoder();
  const enumData = encoder.encode({
    __kind: 'Init',
    fields: [initArgs],
  });

  // Prepend 8-byte discriminator
  const data = new Uint8Array(8 + enumData.length);
  data.set(PROGRAM_INSTRUCTION_DISCRIMINATOR, 0);
  data.set(enumData, 8);

  return {
    programAddress: programId,
    accounts: [
      { address: SYSTEM_PROGRAM_ID, role: 0 },
      { address: tokenPda, role: 1 },
      { address: dispatchAuthPda, role: 1 },
      { address: payer, role: 3 },
      { address: nativeCollateralPda, role: 1 },
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
  constructor(private readonly rpc: Rpc<SolanaRpcApi>) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<RawNativeWarpArtifactConfig, DeployedWarpAddress>
  > {
    const programId = address as Address;
    const token = await fetchNativeToken(this.rpc, programId);
    assert(token !== null, `Native token not initialized at ${programId}`);

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
      owner: token.owner ?? '',
      mailbox: token.mailbox,
      interchainSecurityModule: token.interchainSecurityModule
        ? {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: token.interchainSecurityModule },
          }
        : undefined,
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
  implements ArtifactWriter<RawNativeWarpArtifactConfig, DeployedWarpAddress>
{
  constructor(
    private readonly rpc: Rpc<SolanaRpcApi>,
    private readonly signer: SvmSigner,
    private readonly programBytes: Uint8Array,
  ) {}

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
    console.log('Deploying native token program...');
    const deployResult = await deployProgram({
      rpc: this.rpc,
      signer: this.signer,
      programBytes: this.programBytes,
    });

    const programId = deployResult.programId;
    receipts.push(...deployResult.receipts);
    console.log(
      `Program deployed: ${programId} (${deployResult.receipts.length} txs)`,
    );

    // Step 2: Derive PDAs
    const [tokenPda] = await getHyperlaneTokenPda(programId);
    const [dispatchAuthPda] = await getDispatchAuthorityPda(programId);
    const [nativeCollateralPda] = await getNativeCollateralPda(programId);

    // Step 3: Initialize
    const initArgs: InitProxyArgs = {
      mailbox: config.mailbox as Address,
      interchainSecurityModule: config.interchainSecurityModule?.deployed
        ?.address
        ? (config.interchainSecurityModule.deployed.address as Address)
        : null,
      interchainGasPaymaster: null,
      decimals: 9,
      remoteDecimals: 9,
    };

    // Check that accounts don't already exist
    console.log(`Checking if PDAs already exist...`);
    const tokenExists = await this.rpc.getAccountInfo(tokenPda).send();
    const dispatchAuthExists = await this.rpc
      .getAccountInfo(dispatchAuthPda)
      .send();
    const nativeCollateralExists = await this.rpc
      .getAccountInfo(nativeCollateralPda)
      .send();
    console.log(
      `  Token PDA (${tokenPda}): ${tokenExists.value ? 'EXISTS' : 'NONE'}`,
    );
    console.log(
      `  Dispatch Auth (${dispatchAuthPda}): ${dispatchAuthExists.value ? 'EXISTS' : 'NONE'}`,
    );
    console.log(
      `  Native Collateral (${nativeCollateralPda}): ${nativeCollateralExists.value ? 'EXISTS' : 'NONE'}`,
    );

    console.log('Building Init instruction...');
    const initIx = buildNativeTokenInitInstruction(
      programId,
      this.signer.address,
      tokenPda,
      dispatchAuthPda,
      nativeCollateralPda,
      initArgs,
    );
    console.log(`  Init instruction built for program ${programId}`);

    console.log('Sending Init transaction...');
    console.log(
      `  Instruction data (hex): ${Buffer.from(initIx.data ?? [])
        .toString('hex')
        .slice(0, 100)}...`,
    );

    const initReceipt = await this.signer.signAndSend(this.rpc, {
      instructions: [initIx],
      computeUnits: 400_000,
    });
    receipts.push(initReceipt);
    console.log(`Init tx: ${initReceipt.signature}`);
    console.log(`\n>>> Query this transaction with:`);
    console.log(
      `>>> solana confirm ${initReceipt.signature} --url http://127.0.0.1:8899 -v\n`,
    );

    // Wait for account creation
    await new Promise((r) => setTimeout(r, 2000));

    // Check raw account first
    console.log(`Checking token PDA: ${tokenPda}`);
    const rawAccount = await this.rpc
      .getAccountInfo(tokenPda, { encoding: 'base64' })
      .send();

    if (!rawAccount.value) {
      console.log(`ERROR: No account at token PDA!`);
      console.log(`This means Init instruction failed to create the account.`);
      console.log(`Possible causes:`);
      console.log(`  - Program rejected the instruction`);
      console.log(`  - Wrong accounts passed`);
      console.log(`  - Instruction data malformed`);
      console.log(`Transaction signature: ${initReceipt.signature}`);
      console.log(
        `Query it with: solana confirm ${initReceipt.signature} --url http://127.0.0.1:8899 -v`,
      );
      throw new Error(`Init failed - no account created at ${tokenPda}`);
    }

    console.log(
      `Account exists! Owner: ${rawAccount.value.owner}, Data: ${rawAccount.value.data.length} bytes`,
    );

    // Now try to deserialize
    const tokenCheck = await fetchNativeToken(this.rpc, programId);
    if (tokenCheck === null) {
      console.log(
        `Account exists but deserialization failed - check AccountData wrapper`,
      );
    } else {
      console.log(`Token deserialized successfully!`);
    }

    // Step 4: Configure routers
    if (Object.keys(config.remoteRouters).length > 0) {
      console.log(
        `Enrolling ${Object.keys(config.remoteRouters).length} routers...`,
      );
      const enrollments: RouterEnrollment[] = Object.entries(
        config.remoteRouters,
      ).map(([domain, router]) => ({
        domain: parseInt(domain),
        router: router.address,
      }));

      const enrollIx = await getEnrollRemoteRoutersIx(
        programId,
        this.signer.address,
        enrollments,
      );
      const enrollReceipt = await this.signer.signAndSend(this.rpc, {
        instructions: [enrollIx],
      });
      receipts.push(enrollReceipt);
    }

    // Step 5: Set gas
    if (Object.keys(config.destinationGas).length > 0) {
      console.log('Setting destination gas...');
      const gasConfigs: DestinationGasConfig[] = Object.entries(
        config.destinationGas,
      ).map(([domain, gas]) => ({
        domain: parseInt(domain),
        gas: BigInt(gas),
      }));

      const setGasIx = await getSetDestinationGasConfigsIx(
        programId,
        this.signer.address,
        gasConfigs,
      );
      const setGasReceipt = await this.signer.signAndSend(this.rpc, {
        instructions: [setGasIx],
      });
      receipts.push(setGasReceipt);
    }

    // Step 6: Set ISM
    if (config.interchainSecurityModule?.deployed?.address) {
      console.log('Setting ISM...');
      const setIsmIx = await getSetIsmIx(
        programId,
        this.signer.address,
        config.interchainSecurityModule.deployed.address as Address,
      );
      const setIsmReceipt = await this.signer.signAndSend(this.rpc, {
        instructions: [setIsmIx],
      });
      receipts.push(setIsmReceipt);
    }

    console.log(`Complete. Total: ${receipts.length} txs`);
    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        config,
        deployed: { address: programId },
      },
      receipts,
    ];
  }

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<RawNativeWarpArtifactConfig, DeployedWarpAddress>
  > {
    const reader = new SvmNativeTokenReader(this.rpc);
    return reader.read(address);
  }

  async update(
    artifact: ArtifactDeployed<
      RawNativeWarpArtifactConfig,
      DeployedWarpAddress
    >,
  ): Promise<AnnotatedSvmTransaction[]> {
    const programId = artifact.deployed.address as Address;
    const reader = new SvmNativeTokenReader(this.rpc);
    const current = await reader.read(programId);

    const instructions = await computeWarpTokenUpdateInstructions(
      current.config,
      artifact.config,
      programId,
      this.signer.address,
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
