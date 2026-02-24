import {
  AccountRole,
  type Address,
  type Rpc,
  type SolanaRpcApi,
  address,
  getProgramDerivedAddress,
  getUtf8Encoder,
} from '@solana/kit';
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
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
  RawCollateralWarpArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/warp';
import { ZERO_ADDRESS_HEX_32, assert, isNullish } from '@hyperlane-xyz/utils';

import { deployProgram } from '../deploy/program-deployer.js';
import { getTokenInstructionProxyEncoder } from '../generated/types/index.js';
import type { InitProxyArgs } from '../generated/types/index.js';
import type { SvmSigner } from '../signer.js';
import type {
  AnnotatedSvmTransaction,
  SvmInstruction,
  SvmReceipt,
} from '../types.js';

import {
  RENT_SYSVAR,
  SYSTEM_PROGRAM_ID,
  prependDiscriminator,
} from './constants.js';
import type { SvmWarpTokenConfig } from './types.js';
import {
  fetchCollateralToken,
  getDispatchAuthorityPda,
  getHyperlaneTokenPda,
  routerBytesToHex,
} from './warp-query.js';
import {
  applyPostInitConfig,
  buildBaseInitArgs,
  computeWarpTokenUpdateInstructions,
} from './warp-tx.js';

/**
 * Decodes name, symbol, uri from a Metaplex metadata account.
 * Layout: key(1) + updateAuthority(32) + mint(32), then Borsh strings
 * (u32 LE length prefix + bytes, padded with null bytes).
 */
function decodeMetaplexMetadata(data: Uint8Array): {
  name: string;
  symbol: string;
  uri: string;
} {
  let offset = 65; // skip key(1) + updateAuthority(32) + mint(32)
  const view = new DataView(data.buffer, data.byteOffset);

  function readString(): string {
    const len = view.getUint32(offset, true);
    offset += 4;
    const bytes = data.subarray(offset, offset + len);
    offset += len;
    return new TextDecoder().decode(bytes).replace(/\0/g, '').trim();
  }

  return { name: readString(), symbol: readString(), uri: readString() };
}

async function fetchCollateralMetadata(
  rpcUrl: string,
  mintAddress: string,
): Promise<{ name: string; symbol: string; decimals: number }> {
  const connection = new Connection(rpcUrl, 'confirmed');
  const mintPubkey = new PublicKey(mintAddress);
  const mintInfo = await getMint(
    connection,
    mintPubkey,
    'confirmed',
    TOKEN_2022_PROGRAM_ID,
  ).catch(() => getMint(connection, mintPubkey, 'confirmed', TOKEN_PROGRAM_ID));
  const decimals = mintInfo.decimals;

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
        return { name: metadata.name, symbol: metadata.symbol, decimals };
      }
    }
  } catch {
    // Fall through to Metaplex
  }

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
    if (!accountInfo) throw new Error('Metaplex metadata account not found');
    const { name, symbol } = decodeMetaplexMetadata(accountInfo.data);
    return { name, symbol, decimals };
  } catch {
    return { name: 'Unknown Token', symbol: 'UNKNOWN', decimals };
  }
}

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
      { address: splProgram, role: AccountRole.READONLY },
      { address: mint, role: AccountRole.READONLY },
      { address: RENT_SYSVAR, role: AccountRole.READONLY },
      { address: escrowPda, role: AccountRole.WRITABLE },
      { address: ataPayerPda, role: AccountRole.WRITABLE },
    ],
    data,
  };
}

export class SvmCollateralTokenReader
  implements
    ArtifactReader<RawCollateralWarpArtifactConfig, DeployedWarpAddress>
{
  constructor(
    protected readonly rpc: Rpc<SolanaRpcApi>,
    protected readonly rpcUrl: string,
  ) {}

  async read(
    programAddress: string,
  ): Promise<
    ArtifactDeployed<RawCollateralWarpArtifactConfig, DeployedWarpAddress>
  > {
    const programId = address(programAddress);
    const token = await fetchCollateralToken(this.rpc, programId);
    assert(
      !isNullish(token),
      `Collateral token not initialized at ${programId}`,
    );

    const remoteRouters: Record<number, { address: string }> = {};
    for (const [domain, router] of token.remoteRouters.entries()) {
      remoteRouters[domain] = { address: routerBytesToHex(router) };
    }

    const destinationGas: Record<number, string> = {};
    for (const [domain, gas] of token.destinationGas.entries()) {
      destinationGas[domain] = gas.toString();
    }

    const metadata = await fetchCollateralMetadata(
      this.rpcUrl,
      token.pluginData.mint,
    );

    const igpHook: ArtifactUnderived<{ address: string }> | undefined =
      token.interchainGasPaymaster
        ? {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: token.interchainGasPaymaster[1].fields[0] },
          }
        : undefined;

    const config: RawCollateralWarpArtifactConfig = {
      type: 'collateral',
      owner: token.owner ?? ZERO_ADDRESS_HEX_32,
      mailbox: token.mailbox,
      token: token.pluginData.mint,
      name: metadata.name,
      symbol: metadata.symbol,
      decimals: metadata.decimals,
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

export class SvmCollateralTokenWriter
  extends SvmCollateralTokenReader
  implements
    ArtifactWriter<RawCollateralWarpArtifactConfig, DeployedWarpAddress>
{
  constructor(
    private readonly config: SvmWarpTokenConfig,
    rpc: Rpc<SolanaRpcApi>,
    private readonly signer: SvmSigner,
    rpcUrl: string,
  ) {
    super(rpc, rpcUrl);
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
    const [escrowPda] = await getEscrowPda(programId);
    const [ataPayerPda] = await getAtaPayerPda(programId);

    // Step 3: Determine SPL program from mint
    const collateralMint = address(config.token);
    const mintInfo = await this.rpc
      .getAccountInfo(collateralMint, { encoding: 'base64' })
      .send();
    assert(
      !isNullish(mintInfo.value),
      `Mint account not found: ${collateralMint}`,
    );
    const splProgram = address(mintInfo.value.owner);

    // Step 4: Initialize
    const initArgs = buildBaseInitArgs(
      config,
      this.config.igpProgramId,
      9, // Will be overridden by actual mint decimals at runtime
      9,
    );

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

    const tokenCheck = await fetchCollateralToken(this.rpc, programId);
    if (isNullish(tokenCheck)) {
      throw new Error(`Init failed - token not created at ${programId}`);
    }

    // Step 5: Configure routers, gas, ISM
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
      RawCollateralWarpArtifactConfig,
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

    if (instructions.length === 0) return [];

    return [
      {
        instructions,
        annotation: `Update collateral token ${programId}`,
      },
    ];
  }
}
