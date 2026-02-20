import {
  type Address,
  type Rpc,
  type SolanaRpcApi,
  getAddressEncoder,
  getProgramDerivedAddress,
  getUtf8Encoder,
} from '@solana/kit';

import {
  type ArtifactDeployed,
  type ArtifactNew,
  type ArtifactReader,
  ArtifactState,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import type {
  DeployedWarpAddress,
  RawSyntheticWarpArtifactConfig,
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
  fetchSyntheticToken,
  getDispatchAuthorityPda,
  getHyperlaneTokenPda,
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
const TOKEN_2022_PROGRAM_ID =
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' as Address;
const RENT_SYSVAR = 'SysvarRent111111111111111111111111111111111' as Address;
const PROGRAM_INSTRUCTION_DISCRIMINATOR = new Uint8Array([
  1, 1, 1, 1, 1, 1, 1, 1,
]);

async function getSyntheticMintPda(
  programId: Address,
): Promise<readonly [Address, number]> {
  const utf8 = getUtf8Encoder();
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [
      utf8.encode('hyperlane_token'),
      utf8.encode('-'),
      utf8.encode('mint'),
    ],
  });
}

async function getAtaPayerPda(
  programId: Address,
): Promise<readonly [Address, number]> {
  const utf8 = getUtf8Encoder();
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [
      utf8.encode('hyperlane_token'),
      utf8.encode('-'),
      utf8.encode('ata_payer'),
    ],
  });
}

/**
 * Builds InitializeMetadataPointer instruction.
 * Discriminator: 39
 * Required before InitializeMint2 when mint has metadata extension.
 */
function createInitializeMetadataPointerInstruction(
  mint: Address,
  authority: Address,
  metadataAddress: Address,
): SvmInstruction {
  const addressEncoder = getAddressEncoder();
  const authorityBytes = addressEncoder.encode(authority);
  const metadataBytes = addressEncoder.encode(metadataAddress);

  // [discriminator(1), authority_option(1+32), metadata_option(1+32)]
  const data = new Uint8Array(67);
  data[0] = 39; // InitializeMetadataPointer
  data[1] = 1; // COption::Some
  data.set(authorityBytes, 2);
  data[34] = 1; // COption::Some
  data.set(metadataBytes, 35);

  return {
    programAddress: TOKEN_2022_PROGRAM_ID,
    accounts: [{ address: mint, role: 1 }],
    data,
  };
}

/**
 * Builds SPL Token-2022 InitializeMint2 instruction.
 * Discriminator: 20
 * Args: decimals(u8), mint_authority(Pubkey), freeze_authority(COption<Pubkey>)
 */
function createInitializeMint2Instruction(
  mint: Address,
  decimals: number,
  mintAuthority: Address,
): SvmInstruction {
  const addressEncoder = getAddressEncoder();
  const mintAuthorityBytes = addressEncoder.encode(mintAuthority);

  // [discriminator(1), decimals(1), mint_authority(32), freeze_authority_option(1)]
  const data = new Uint8Array(35);
  data[0] = 20; // InitializeMint2
  data[1] = decimals;
  data.set(mintAuthorityBytes, 2);
  data[34] = 0; // COption::None for freeze authority

  return {
    programAddress: TOKEN_2022_PROGRAM_ID,
    accounts: [
      { address: mint, role: 1 }, // writable
      { address: RENT_SYSVAR, role: 0 }, // rent sysvar
    ],
    data,
  };
}

function buildSyntheticTokenInitInstruction(
  programId: Address,
  payer: Address,
  tokenPda: Address,
  dispatchAuthPda: Address,
  mintPda: Address,
  ataPayerPda: Address,
  initArgs: InitProxyArgs,
): SvmInstruction {
  const encoder = getTokenInstructionProxyEncoder();
  const enumData = encoder.encode({
    __kind: 'Init',
    fields: [initArgs],
  });

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
      { address: mintPda, role: 1 },
      { address: ataPayerPda, role: 1 },
    ],
    data,
  };
}

export class SvmSyntheticTokenReader
  implements ArtifactReader<RawSyntheticWarpArtifactConfig, DeployedWarpAddress>
{
  constructor(private readonly rpc: Rpc<SolanaRpcApi>) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<RawSyntheticWarpArtifactConfig, DeployedWarpAddress>
  > {
    const programId = address as Address;
    const token = await fetchSyntheticToken(this.rpc, programId);
    assert(token !== null, `Synthetic token not initialized at ${programId}`);

    const remoteRouters: Record<number, { address: string }> = {};
    for (const [domain, router] of token.remoteRouters.entries()) {
      remoteRouters[domain] = { address: routerBytesToHex(router) };
    }

    const destinationGas: Record<number, string> = {};
    for (const [domain, gas] of token.destinationGas.entries()) {
      destinationGas[domain] = gas.toString();
    }

    const config: RawSyntheticWarpArtifactConfig = {
      type: 'synthetic',
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
      name: 'Synthetic',
      symbol: 'SYN',
      decimals: token.decimals,
    };

    return {
      artifactState: ArtifactState.DEPLOYED,
      config,
      deployed: { address: programId },
    };
  }
}

export class SvmSyntheticTokenWriter
  implements ArtifactWriter<RawSyntheticWarpArtifactConfig, DeployedWarpAddress>
{
  constructor(
    private readonly rpc: Rpc<SolanaRpcApi>,
    private readonly signer: SvmSigner,
    private readonly programBytes: Uint8Array,
  ) {}

  async create(
    artifact: ArtifactNew<RawSyntheticWarpArtifactConfig>,
  ): Promise<
    [
      ArtifactDeployed<RawSyntheticWarpArtifactConfig, DeployedWarpAddress>,
      SvmReceipt[],
    ]
  > {
    const receipts: SvmReceipt[] = [];
    const config = artifact.config;

    // Step 1: Deploy program
    console.log('Deploying synthetic token program...');
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
    const [mintPda] = await getSyntheticMintPda(programId);
    const [ataPayerPda] = await getAtaPayerPda(programId);

    // Step 3: Build Init args
    const initArgs: InitProxyArgs = {
      mailbox: config.mailbox as Address,
      interchainSecurityModule: config.interchainSecurityModule?.deployed
        ?.address
        ? (config.interchainSecurityModule.deployed.address as Address)
        : null,
      interchainGasPaymaster: null,
      decimals: config.decimals,
      remoteDecimals: config.decimals,
    };

    // Step 4: Build Init instruction
    console.log('Building Init + SPL mint instructions...');
    const initIx = buildSyntheticTokenInitInstruction(
      programId,
      this.signer.address,
      tokenPda,
      dispatchAuthPda,
      mintPda,
      ataPayerPda,
      initArgs,
    );

    // Step 5: Build SPL Token-2022 instructions
    // 5a. InitializeMetadataPointer (extension - must come before InitMint)
    const initMetadataPtrIx = createInitializeMetadataPointerInstruction(
      mintPda,
      mintPda, // Authority = mint itself
      mintPda, // Metadata stored in mint account
    );

    // 5b. InitializeMint2
    const initMintIx = createInitializeMint2Instruction(
      mintPda,
      config.decimals,
      this.signer.address, // Mint authority = payer
    );

    // Step 6: Send Init + MetadataPointer + InitMint in SAME transaction
    console.log('Sending Init + extensions + mint transaction...');
    console.log(`  Init: ${initIx.data?.length ?? 0} bytes`);
    console.log(`  MetadataPtr: ${initMetadataPtrIx.data?.length ?? 0} bytes`);
    console.log(`  InitMint: ${initMintIx.data?.length ?? 0} bytes`);
    const initReceipt = await this.signer.signAndSend(this.rpc, {
      instructions: [initIx, initMetadataPtrIx, initMintIx],
      computeUnits: 400_000,
    });
    receipts.push(initReceipt);
    console.log(`Init tx: ${initReceipt.signature}`);
    console.log(
      `Query: solana confirm ${initReceipt.signature} --url http://127.0.0.1:8899 -v`,
    );

    // Wait for confirmation
    await new Promise((r) => setTimeout(r, 2000));

    // Verify token created
    const tokenCheck = await fetchSyntheticToken(this.rpc, programId);
    if (tokenCheck === null) {
      console.log(`ERROR: Token not created at PDA`);
      throw new Error(
        `Init failed - check tx: solana confirm ${initReceipt.signature} --url http://127.0.0.1:8899 -v`,
      );
    }
    console.log('Synthetic token created!');

    // Step 7: Configure routers
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

    // Step 8: Set gas
    if (Object.keys(config.destinationGas).length > 0) {
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

    // Step 9: Set ISM
    if (config.interchainSecurityModule?.deployed?.address) {
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

    console.log(`Deployment complete. Total: ${receipts.length} txs`);
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
    ArtifactDeployed<RawSyntheticWarpArtifactConfig, DeployedWarpAddress>
  > {
    const reader = new SvmSyntheticTokenReader(this.rpc);
    return reader.read(address);
  }

  async update(
    artifact: ArtifactDeployed<
      RawSyntheticWarpArtifactConfig,
      DeployedWarpAddress
    >,
  ): Promise<AnnotatedSvmTransaction[]> {
    const programId = artifact.deployed.address as Address;
    const reader = new SvmSyntheticTokenReader(this.rpc);
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
        annotation: `Update synthetic token ${programId}`,
      },
    ];
  }
}
