import {
  type Address,
  type Rpc,
  type SolanaRpcApi,
  getAddressEncoder,
  getProgramDerivedAddress,
  getUtf8Encoder,
} from '@solana/kit';
import {
  TOKEN_2022_PROGRAM_ID,
  getMetadataPointerState,
  getMint,
  getTokenMetadata,
} from '@solana/spl-token';
import { Connection, PublicKey } from '@solana/web3.js';

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
 * From Rust reference: discriminator is [39, 0] (2 bytes)
 * Fields use OptionalNonZeroPubkey (32 bytes, all zeros = None)
 */
export function createInitializeMetadataPointerInstruction(
  mint: Address,
  authority: Address | null,
  metadataAddress: Address | null,
): SvmInstruction {
  const addressEncoder = getAddressEncoder();

  // [discriminator(2), authority(32), metadata(32)] = 66 bytes
  const data = new Uint8Array(66);
  data[0] = 39; // MetadataPointerExtension
  data[1] = 0; // Initialize variant

  // OptionalNonZeroPubkey: all zeros = None, otherwise encode address
  if (authority) {
    data.set(addressEncoder.encode(authority), 2);
  }
  // else: leave zeros (None)

  if (metadataAddress) {
    data.set(addressEncoder.encode(metadataAddress), 34);
  }
  // else: leave zeros (None)

  return {
    programAddress: TOKEN_2022_PROGRAM_ID.toBase58() as Address,
    accounts: [{ address: mint, role: 0 }], // readonly
    data,
  };
}

/**
 * Builds SPL Token-2022 InitializeMint2 instruction.
 * Discriminator: 20
 * Args: decimals(u8), mint_authority(Pubkey), freeze_authority(COption<Pubkey>)
 */
export function createInitializeMint2Instruction(
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
    programAddress: TOKEN_2022_PROGRAM_ID.toBase58() as Address,
    accounts: [
      { address: mint, role: 1 }, // writable
      { address: RENT_SYSVAR, role: 0 }, // rent sysvar
    ],
    data,
  };
}

// Removed - using @solana/spl-token-metadata createInitializeInstruction instead

/**
 * Builds SetAuthority instruction to transfer mint authority.
 * Discriminator: 6
 */
function createSetAuthorityInstruction(
  mint: Address,
  currentAuthority: Address,
  newAuthority: Address,
): SvmInstruction {
  const addressEncoder = getAddressEncoder();
  const newAuthorityBytes = addressEncoder.encode(newAuthority);

  // [discriminator(1), authority_type(1), new_authority_option(1+32)]
  const data = new Uint8Array(35);
  data[0] = 6; // SetAuthority
  data[1] = 0; // AuthorityType::MintTokens
  data[2] = 1; // COption::Some
  data.set(newAuthorityBytes, 3);

  return {
    programAddress: TOKEN_2022_PROGRAM_ID.toBase58() as Address,
    accounts: [
      { address: mint, role: 1 }, // writable
      { address: currentAuthority, role: 2 }, // current authority signer
    ],
    data,
  };
}

/**
 * 8-byte discriminator from spl_token_metadata_interface:initialize_account
 */
export const METADATA_INITIALIZE_DISCRIMINATOR = new Uint8Array([
  210, 225, 30, 162, 88, 184, 77, 141,
]);

export function createInitializeMetadataInstruction(
  mint: Address,
  updateAuthority: Address,
  mintAuthority: Address,
  name: string,
  symbol: string,
  uri: string,
): SvmInstruction {
  const nameBytes = new TextEncoder().encode(name);
  const symbolBytes = new TextEncoder().encode(symbol);
  const uriBytes = new TextEncoder().encode(uri);

  const dataLen =
    8 + 4 + nameBytes.length + 4 + symbolBytes.length + 4 + uriBytes.length;
  const data = new Uint8Array(dataLen);

  data.set(METADATA_INITIALIZE_DISCRIMINATOR, 0);

  let offset = 8;
  new DataView(data.buffer).setUint32(offset, nameBytes.length, true);
  offset += 4;
  data.set(nameBytes, offset);
  offset += nameBytes.length;

  new DataView(data.buffer).setUint32(offset, symbolBytes.length, true);
  offset += 4;
  data.set(symbolBytes, offset);
  offset += symbolBytes.length;

  new DataView(data.buffer).setUint32(offset, uriBytes.length, true);
  offset += 4;
  data.set(uriBytes, offset);

  return {
    programAddress: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' as Address,
    accounts: [
      { address: mint, role: 1 },
      { address: updateAuthority, role: 0 },
      { address: mint, role: 0 },
      { address: mintAuthority, role: 2 },
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

/**
 * Fetches token metadata from SPL Token-2022 mint account.
 */
async function fetchTokenMetadata(
  rpcUrl: string,
  programId: Address,
): Promise<{ name: string; symbol: string; uri: string } | null> {
  const [mintPda] = await getSyntheticMintPda(programId);

  try {
    const connection = new Connection(rpcUrl, 'confirmed');
    const mintPubkey = new PublicKey(mintPda);

    // Step 1: Get mint info with TOKEN_2022_PROGRAM_ID
    const mintInfo = await getMint(
      connection,
      mintPubkey,
      'confirmed',
      TOKEN_2022_PROGRAM_ID,
    );

    // Step 2: Extract metadata pointer from mint extensions
    const metadataPointer = getMetadataPointerState(mintInfo);
    if (!metadataPointer?.metadataAddress) {
      console.log('No metadata pointer in mint');
      return null;
    }

    // Step 3: Fetch metadata from pointer address
    const metadata = await getTokenMetadata(
      connection,
      metadataPointer.metadataAddress,
      'confirmed',
      TOKEN_2022_PROGRAM_ID,
    );

    console.log('META', metadata);

    return metadata
      ? { name: metadata.name, symbol: metadata.symbol, uri: metadata.uri }
      : null;
  } catch (error) {
    console.error('Error fetching Token-2022 metadata:', error);
    return null;
  }
}

export class SvmSyntheticTokenReader
  implements ArtifactReader<RawSyntheticWarpArtifactConfig, DeployedWarpAddress>
{
  constructor(
    private readonly rpc: Rpc<SolanaRpcApi>,
    private readonly rpcUrl: string, // Mandatory for metadata fetching
  ) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<RawSyntheticWarpArtifactConfig, DeployedWarpAddress>
  > {
    const programId = address as Address;
    const token = await fetchSyntheticToken(this.rpc, programId);
    assert(token !== null, `Synthetic token not initialized at ${programId}`);

    console.log('READ RAW', JSON.stringify(token, null, 2));

    const remoteRouters: Record<number, { address: string }> = {};
    for (const [domain, router] of token.remoteRouters.entries()) {
      remoteRouters[domain] = { address: routerBytesToHex(router) };
    }

    const destinationGas: Record<number, string> = {};
    for (const [domain, gas] of token.destinationGas.entries()) {
      destinationGas[domain] = gas.toString();
    }

    // Fetch metadata from mint account
    const metadata = await fetchTokenMetadata(this.rpcUrl, programId);

    const igpHook: ArtifactUnderived<{ address: string }> | undefined =
      token.interchainGasPaymaster
        ? {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: token.interchainGasPaymaster[1].fields[0] },
          }
        : undefined;

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
      hook: igpHook,
      remoteRouters,
      destinationGas,
      name: metadata?.name ?? 'Unknown',
      symbol: metadata?.symbol ?? 'UNK',
      decimals: token.decimals,
    };

    return {
      artifactState: ArtifactState.DEPLOYED,
      config,
      deployed: { address: programId },
    };
  }
}

export type SyntheticDeployConfigWithMetadata =
  RawSyntheticWarpArtifactConfig & {
    metadataUri?: string;
  };

export class SvmSyntheticTokenWriter
  implements
    ArtifactWriter<SyntheticDeployConfigWithMetadata, DeployedWarpAddress>
{
  constructor(
    private readonly rpc: Rpc<SolanaRpcApi>,
    private readonly signer: SvmSigner,
    private readonly programBytes: Uint8Array,
    private readonly rpcUrl: string, // Mandatory for metadata operations
    private readonly igpProgramId?: Address,
  ) {}

  async create(
    artifact: ArtifactNew<SyntheticDeployConfigWithMetadata>,
  ): Promise<
    [
      ArtifactDeployed<SyntheticDeployConfigWithMetadata, DeployedWarpAddress>,
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
    const igpAccountAddress = config.hook?.deployed?.address;
    const initArgs: InitProxyArgs = {
      mailbox: config.mailbox as Address,
      interchainSecurityModule: config.interchainSecurityModule?.deployed
        ?.address
        ? (config.interchainSecurityModule.deployed.address as Address)
        : null,
      interchainGasPaymaster:
        this.igpProgramId && igpAccountAddress
          ? [
              this.igpProgramId,
              {
                __kind: 'OverheadIgp',
                fields: [igpAccountAddress as Address],
              },
            ]
          : null,
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
      this.signer.address, // Authority = mint itself
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

    // Step 7: Fund mint for metadata + initialize
    if (config.name && config.symbol) {
      console.log('Initializing metadata...');

      // Fund mint account for metadata extension (~1M lamports for safety)
      const fundMintData = new Uint8Array(12);
      fundMintData[0] = 2; // Transfer instruction
      new DataView(fundMintData.buffer).setBigUint64(
        4,
        BigInt(1_000_000),
        true,
      );

      const fundMintIx: SvmInstruction = {
        programAddress: SYSTEM_PROGRAM_ID,
        accounts: [
          { address: this.signer.address, role: 3 }, // from (writable + signer)
          { address: mintPda, role: 1 }, // to (writable)
        ],
        data: fundMintData,
      };

      const initMetadataIx = createInitializeMetadataInstruction(
        mintPda,
        this.signer.address,
        this.signer.address,
        config.name,
        config.symbol,
        config.metadataUri ?? '',
      );

      // Send funding + metadata init in same transaction
      const metadataReceipt = await this.signer.signAndSend(this.rpc, {
        instructions: [fundMintIx, initMetadataIx],
      });
      receipts.push(metadataReceipt);
      console.log(`Metadata tx: ${metadataReceipt.signature}`);
    }

    // Step 8: Transfer mint authority to mint PDA (self-authority for minting)
    console.log('Transferring mint authority to mint PDA...');
    const setAuthorityIx = createSetAuthorityInstruction(
      mintPda,
      this.signer.address, // Current authority (payer)
      mintPda, // New authority (mint PDA itself)
    );

    const authorityReceipt = await this.signer.signAndSend(this.rpc, {
      instructions: [setAuthorityIx],
    });
    receipts.push(authorityReceipt);
    console.log(
      'Mint authority transferred to mint PDA',
      authorityReceipt.signature,
    );

    // Step 9: Configure routers
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
    const reader = new SvmSyntheticTokenReader(this.rpc, this.rpcUrl);
    return reader.read(address);
  }

  async update(
    artifact: ArtifactDeployed<
      RawSyntheticWarpArtifactConfig,
      DeployedWarpAddress
    >,
  ): Promise<AnnotatedSvmTransaction[]> {
    const programId = artifact.deployed.address as Address;
    const reader = new SvmSyntheticTokenReader(this.rpc, this.rpcUrl);
    const current = await reader.read(programId);

    const instructions = await computeWarpTokenUpdateInstructions(
      current.config,
      artifact.config,
      programId,
      this.signer.address,
      this.igpProgramId,
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
