import {
  type Address,
  type Rpc,
  type SolanaRpcApi,
  getProgramDerivedAddress,
  getUtf8Encoder,
} from '@solana/kit';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getMint,
  getMetadataPointerState,
  getTokenMetadata,
} from '@solana/spl-token';
import { deserializeUnchecked } from 'borsh';

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
  fetchCollateralToken,
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
const RENT_SYSVAR = 'SysvarRent111111111111111111111111111111111' as Address;
const PROGRAM_INSTRUCTION_DISCRIMINATOR = new Uint8Array([
  1, 1, 1, 1, 1, 1, 1, 1,
]);

// Borsh schema for Metaplex metadata
class MetadataData {
  name: string;
  symbol: string;
  uri: string;
  sellerFeeBasisPoints: number;
  creators: any[] | null;

  constructor(fields: {
    name: string;
    symbol: string;
    uri: string;
    sellerFeeBasisPoints: number;
    creators: any[] | null;
  }) {
    this.name = fields.name;
    this.symbol = fields.symbol;
    this.uri = fields.uri;
    this.sellerFeeBasisPoints = fields.sellerFeeBasisPoints;
    this.creators = fields.creators;
  }
}

class Metadata {
  key: number;
  updateAuthority: Uint8Array;
  mint: Uint8Array;
  data: MetadataData;
  primarySaleHappened: boolean;
  isMutable: boolean;

  constructor(fields: {
    key: number;
    updateAuthority: Uint8Array;
    mint: Uint8Array;
    data: MetadataData;
    primarySaleHappened: boolean;
    isMutable: boolean;
  }) {
    this.key = fields.key;
    this.updateAuthority = fields.updateAuthority;
    this.mint = fields.mint;
    this.data = fields.data;
    this.primarySaleHappened = fields.primarySaleHappened;
    this.isMutable = fields.isMutable;
  }
}

const SPL_TOKEN_METADATA_SCHEMA = new Map<any, any>([
  [
    MetadataData,
    {
      kind: 'struct',
      fields: [
        ['name', 'string'],
        ['symbol', 'string'],
        ['uri', 'string'],
        ['sellerFeeBasisPoints', 'u16'],
        ['creators', { kind: 'option', type: [{ kind: 'vec', type: 'u8' }] }],
      ],
    },
  ],
  [
    Metadata,
    {
      kind: 'struct',
      fields: [
        ['key', 'u8'],
        ['updateAuthority', [32]],
        ['mint', [32]],
        ['data', MetadataData],
        ['primarySaleHappened', 'u8'],
        ['isMutable', 'u8'],
      ],
    },
  ],
]);

/**
 * Fetches collateral token metadata (name, symbol, decimals).
 * Tries Token-2022 metadata extension first, falls back to Metaplex.
 */
async function fetchCollateralMetadata(
  rpcUrl: string,
  mintAddress: string,
): Promise<{ name: string; symbol: string; decimals: number }> {
  const connection = new Connection(rpcUrl, 'confirmed');
  const mintPubkey = new PublicKey(mintAddress);

  // Get mint info
  const mintInfo = await getMint(
    connection,
    mintPubkey,
    'confirmed',
    TOKEN_2022_PROGRAM_ID,
  ).catch(() =>
    getMint(connection, mintPubkey, 'confirmed', TOKEN_PROGRAM_ID),
  );

  const decimals = mintInfo.decimals;

  // Try Token-2022 metadata extension
  try {
    const metadataPointer = getMetadataPointerState(mintInfo);
    if (metadataPointer?.metadataAddress) {
      const metadata = await getTokenMetadata(
        connection,
        mintPubkey,
        'confirmed',
        TOKEN_2022_PROGRAM_ID,
      );
      if (metadata?.name && metadata?.symbol) {
        return {
          name: metadata.name,
          symbol: metadata.symbol,
          decimals,
        };
      }
    }
  } catch {
    // Fall through to Metaplex
  }

  // Fallback to Metaplex
  try {
    const METAPLEX_PROGRAM_ID = new PublicKey(
      'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
    );
    const [metadataPDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from('metadata'),
        METAPLEX_PROGRAM_ID.toBuffer(),
        mintPubkey.toBuffer(),
      ],
      METAPLEX_PROGRAM_ID,
    );

    const accountInfo = await connection.getAccountInfo(metadataPDA);
    if (!accountInfo) {
      throw new Error('Metaplex metadata account not found');
    }

    const metadata = deserializeUnchecked(
      SPL_TOKEN_METADATA_SCHEMA,
      Metadata,
      accountInfo.data,
    ) as Metadata;

    return {
      name: metadata.data.name.replace(/\0/g, '').trim(),
      symbol: metadata.data.symbol.replace(/\0/g, '').trim(),
      decimals,
    };
  } catch (error) {
    console.warn(
      `Failed to fetch metadata for ${mintAddress}, using defaults:`,
      error,
    );
    return {
      name: 'Unknown Token',
      symbol: 'UNKNOWN',
      decimals,
    };
  }
}

/**
 * Derives the escrow token account PDA.
 * Seeds: ["hyperlane_token", "-", "escrow"]
 */
async function getEscrowPda(
  programId: Address,
): Promise<readonly [Address, number]> {
  const utf8 = getUtf8Encoder();
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [
      utf8.encode('hyperlane_token'),
      utf8.encode('-'),
      utf8.encode('escrow'),
    ],
  });
}

/**
 * Derives the ATA payer PDA.
 * Seeds: ["hyperlane_token", "-", "ata_payer"]
 */
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
 * Builds Init instruction for collateral token.
 *
 * Accounts (from Rust):
 * 0. System program
 * 1. Token PDA
 * 2. Dispatch authority PDA
 * 3. Payer
 * 4. SPL token program (Token or Token-2022)
 * 5. Existing mint
 * 6. Rent sysvar
 * 7. Escrow PDA
 * 8. ATA payer PDA
 */
function buildCollateralTokenInitInstruction(
  programId: Address,
  payer: Address,
  tokenPda: Address,
  dispatchAuthPda: Address,
  splProgram: Address,
  mint: Address,
  escrowPda: Address,
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
      { address: splProgram, role: 0 }, // SPL program (executable)
      { address: mint, role: 0 }, // Existing mint (readonly)
      { address: RENT_SYSVAR, role: 0 }, // Rent sysvar
      { address: escrowPda, role: 1 }, // Escrow PDA (writable)
      { address: ataPayerPda, role: 1 }, // ATA payer PDA (writable)
    ],
    data,
  };
}

export class SvmCollateralTokenReader
  implements ArtifactReader<RawCollateralWarpArtifactConfig, DeployedWarpAddress>
{
  constructor(
    private readonly rpc: Rpc<SolanaRpcApi>,
    private readonly rpcUrl: string,
  ) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<RawCollateralWarpArtifactConfig, DeployedWarpAddress>
  > {
    const programId = address as Address;
    const token = await fetchCollateralToken(this.rpc, programId);
    assert(token !== null, `Collateral token not initialized at ${programId}`);

    const remoteRouters: Record<number, { address: string }> = {};
    for (const [domain, router] of token.remoteRouters.entries()) {
      remoteRouters[domain] = { address: routerBytesToHex(router) };
    }

    const destinationGas: Record<number, string> = {};
    for (const [domain, gas] of token.destinationGas.entries()) {
      destinationGas[domain] = gas.toString();
    }

    // Fetch metadata
    const metadata = await fetchCollateralMetadata(
      this.rpcUrl,
      token.pluginData.mint,
    );

    const config: RawCollateralWarpArtifactConfig = {
      type: 'collateral',
      owner: token.owner ?? '',
      mailbox: token.mailbox,
      token: token.pluginData.mint, // The collateral mint address
      name: metadata.name,
      symbol: metadata.symbol,
      decimals: metadata.decimals,
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

export class SvmCollateralTokenWriter
  implements ArtifactWriter<RawCollateralWarpArtifactConfig, DeployedWarpAddress>
{
  constructor(
    private readonly rpc: Rpc<SolanaRpcApi>,
    private readonly signer: SvmSigner,
    private readonly programBytes: Uint8Array,
    private readonly rpcUrl: string,
  ) {}

  async create(
    artifact: ArtifactNew<RawCollateralWarpArtifactConfig>,
  ): Promise<
    [
      ArtifactDeployed<RawCollateralWarpArtifactConfig, DeployedWarpAddress>,
      SvmReceipt[],
    ]
  > {
    const receipts: SvmReceipt[] = [];
    const config = artifact.config;

    // Step 1: Deploy program
    console.log('Deploying collateral token program...');
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
    const [escrowPda] = await getEscrowPda(programId);
    const [ataPayerPda] = await getAtaPayerPda(programId);

    // Step 3: Determine SPL program from mint
    const collateralMint = config.token as Address;
    console.log(`Using collateral mint: ${collateralMint}`);

    // Query mint to determine if it's Token or Token-2022
    const mintInfo = await this.rpc
      .getAccountInfo(collateralMint, { encoding: 'base64' })
      .send();
    const splProgram = mintInfo.value?.owner ?? (
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address
    );
    console.log(`SPL program: ${splProgram}`);

    // Step 4: Build Init instruction
    const initArgs: InitProxyArgs = {
      mailbox: config.mailbox as Address,
      interchainSecurityModule: config.interchainSecurityModule?.deployed
        ?.address
        ? (config.interchainSecurityModule.deployed.address as Address)
        : null,
      interchainGasPaymaster: null,
      decimals: 9, // Will be overridden by actual mint decimals
      remoteDecimals: 9,
    };

    console.log('Sending Init transaction...');
    const initIx = buildCollateralTokenInitInstruction(
      programId,
      this.signer.address,
      tokenPda,
      dispatchAuthPda,
      splProgram,
      collateralMint,
      escrowPda,
      ataPayerPda,
      initArgs,
    );

    const initReceipt = await this.signer.signAndSend(this.rpc, {
      instructions: [initIx],
      computeUnits: 400_000,
    });
    receipts.push(initReceipt);
    console.log(`Init tx: ${initReceipt.signature}`);

    // Verify token created
    const tokenCheck = await fetchCollateralToken(this.rpc, programId);
    if (tokenCheck === null) {
      throw new Error(`Init failed - token not created`);
    }
    console.log('Collateral token created!');

    // Step 5: Configure routers
    if (Object.keys(config.remoteRouters).length > 0) {
      console.log(`Enrolling ${Object.keys(config.remoteRouters).length} routers...`);
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

    // Step 6: Set gas
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

    // Step 7: Set ISM
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
    ArtifactDeployed<RawCollateralWarpArtifactConfig, DeployedWarpAddress>
  > {
    const reader = new SvmCollateralTokenReader(this.rpc, this.rpcUrl);
    return reader.read(address);
  }

  async update(
    artifact: ArtifactDeployed<
      RawCollateralWarpArtifactConfig,
      DeployedWarpAddress
    >,
  ): Promise<AnnotatedSvmTransaction[]> {
    const programId = artifact.deployed.address as Address;
    const reader = new SvmCollateralTokenReader(this.rpc, this.rpcUrl);
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
        annotation: `Update collateral token ${programId}`,
      },
    ];
  }
}
