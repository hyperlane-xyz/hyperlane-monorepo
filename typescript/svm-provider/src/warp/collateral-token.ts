import { address as parseAddress } from '@solana/kit';
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
} from './warp-tx.js';
import { fetchTokenAccount, routerBytesToHex } from './warp-query.js';
import type { SvmWarpTokenConfig } from './types.js';

/**
 * Decodes name, symbol, uri from a Metaplex metadata account.
 * Layout: key(1) + updateAuthority(32) + mint(32), then Borsh strings.
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

  // Try Token 2022 metadata pointer first.
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
    // Fall through to Metaplex.
  }

  // Try Metaplex metadata account.
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

export class SvmCollateralTokenReader implements ArtifactReader<
  RawCollateralWarpArtifactConfig,
  DeployedWarpAddress
> {
  constructor(
    protected readonly rpc: SvmRpc,
    protected readonly rpcUrl: string,
  ) {}

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

    const metadata = await fetchCollateralMetadata(this.rpcUrl, plugin.mint);

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

    const initData = buildBaseInitData(
      tokenConfig,
      this.config.igpProgramId,
      9, // Rust program reads actual decimals from the mint at init time.
      9,
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
