import {
  type Address,
  address as parseAddress,
  getAddressEncoder,
  type TransactionSigner,
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
import { ZERO_ADDRESS_HEX_32, assert, isNullish } from '@hyperlane-xyz/utils';

import { resolveProgram } from '../deploy/resolve-program.js';
import {
  RENT_SYSVAR_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
} from '../constants.js';
import { concatBytes, u8, u32le } from '../codecs/binary.js';
import { encodeTokenProgramInstruction } from '../instructions/token.js';
import { fetchMintMetadata } from '../accounts/mint.js';
import {
  buildInstruction,
  readonlyAccount,
  readonlySigner,
  writableAccount,
  writableSigner,
} from '../instructions/utils.js';
import {
  deriveAtaPayerPda,
  deriveHyperlaneTokenPda,
  deriveMailboxDispatchAuthorityPda,
  deriveSyntheticMintPda,
} from '../pda.js';
import type { SvmSigner } from '../signer.js';
import type {
  AnnotatedSvmTransaction,
  SvmInstruction,
  SvmRpc,
  SvmReceipt,
} from '../types.js';

import {
  applyPostInitConfig,
  buildBaseInitData,
  computeWarpTokenUpdateInstructions,
  remoteDecimalsToScale,
  scaleToRemoteDecimals,
} from './warp-tx.js';
import { fetchTokenAccount, routerBytesToHex } from './warp-query.js';
import type { SvmWarpTokenConfig } from './types.js';

// Borsh discriminator for the Token 2022 InitializeTokenMetadata instruction.
const METADATA_INITIALIZE_DISCRIMINATOR = new Uint8Array([
  210, 225, 30, 162, 88, 184, 77, 141,
]);

const addressEncoder = getAddressEncoder();

/**
 * SPL Token 2022: InitializeMetadataPointer (extension type 39).
 * authority and metadataAddress are encoded into the 66-byte payload.
 */
function createInitializeMetadataPointerInstruction(
  mint: Address,
  authority: Address,
  metadataAddress: Address,
): SvmInstruction {
  const data = new Uint8Array(66);
  data[0] = 39; // extension type: MetadataPointer
  data[1] = 0;
  data.set(addressEncoder.encode(authority), 2);
  data.set(addressEncoder.encode(metadataAddress), 34);
  return buildInstruction(
    TOKEN_2022_PROGRAM_ADDRESS,
    [readonlyAccount(mint)],
    data,
  );
}

/** SPL Token 2022: InitializeMint2 (discriminator 20). */
function createInitializeMint2Instruction(
  mint: Address,
  decimals: number,
  mintAuthority: Address,
): SvmInstruction {
  const data = concatBytes(
    u8(20), // InitializeMint2 discriminator
    u8(decimals),
    addressEncoder.encode(mintAuthority),
    u8(0), // freeze authority: None
  );
  return buildInstruction(
    TOKEN_2022_PROGRAM_ADDRESS,
    [writableAccount(mint), readonlyAccount(RENT_SYSVAR_ADDRESS)],
    data,
  );
}

/** SPL Token 2022: SetAuthority (discriminator 6, authority type 0 = MintTokens). */
function createSetAuthorityInstruction(
  mint: Address,
  currentAuthority: TransactionSigner,
  newAuthority: Address,
): SvmInstruction {
  const data = concatBytes(
    u8(6), // SetAuthority discriminator
    u8(0), // authority type: MintTokens
    u8(1), // has new authority
    addressEncoder.encode(newAuthority),
  );
  return buildInstruction(
    TOKEN_2022_PROGRAM_ADDRESS,
    [writableAccount(mint), readonlySigner(currentAuthority)],
    data,
  );
}

/** SPL Token 2022: InitializeTokenMetadata (Borsh discriminator). */
function createInitializeMetadataInstruction(
  mint: Address,
  updateAuthority: Address,
  mintAuthority: TransactionSigner,
  name: string,
  symbol: string,
  uri: string,
): SvmInstruction {
  const nameBytes = new TextEncoder().encode(name);
  const symbolBytes = new TextEncoder().encode(symbol);
  const uriBytes = new TextEncoder().encode(uri);
  const data = concatBytes(
    METADATA_INITIALIZE_DISCRIMINATOR,
    u32le(nameBytes.length),
    nameBytes,
    u32le(symbolBytes.length),
    symbolBytes,
    u32le(uriBytes.length),
    uriBytes,
  );
  return buildInstruction(
    TOKEN_2022_PROGRAM_ADDRESS,
    [
      writableAccount(mint),
      readonlyAccount(updateAuthority),
      readonlyAccount(mint),
      readonlySigner(mintAuthority),
    ],
    data,
  );
}

export class SvmSyntheticTokenReader implements ArtifactReader<
  RawSyntheticWarpArtifactConfig,
  DeployedWarpAddress
> {
  constructor(protected readonly rpc: SvmRpc) {}

  async read(
    programAddress: string,
  ): Promise<
    ArtifactDeployed<RawSyntheticWarpArtifactConfig, DeployedWarpAddress>
  > {
    const programId = parseAddress(programAddress);
    const token = await fetchTokenAccount(this.rpc, programId);
    assert(
      !isNullish(token),
      `Synthetic token not initialized at ${programId}`,
    );

    const remoteRouters: Record<number, { address: string }> = {};
    for (const [domain, router] of token.remoteRouters.entries()) {
      remoteRouters[domain] = { address: routerBytesToHex(router) };
    }

    const destinationGas: Record<number, string> = {};
    for (const [domain, gas] of token.destinationGas.entries()) {
      destinationGas[domain] = gas.toString();
    }

    const { address: mintPda } = await deriveSyntheticMintPda(programId);
    const metadata = await fetchMintMetadata(this.rpc, mintPda);

    const config: RawSyntheticWarpArtifactConfig = {
      type: 'synthetic',
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
      name: metadata.name,
      symbol: metadata.symbol,
      decimals: token.decimals,
      metadataUri: metadata.uri,
      scale: remoteDecimalsToScale(token.decimals, token.remoteDecimals),
    };

    return {
      artifactState: ArtifactState.DEPLOYED,
      config,
      deployed: { address: programId },
    };
  }
}

export class SvmSyntheticTokenWriter
  extends SvmSyntheticTokenReader
  implements ArtifactWriter<RawSyntheticWarpArtifactConfig, DeployedWarpAddress>
{
  constructor(
    private readonly config: SvmWarpTokenConfig,
    rpc: SvmRpc,
    private readonly svmSigner: SvmSigner,
  ) {
    super(rpc);
  }

  async create(
    artifact: ArtifactNew<RawSyntheticWarpArtifactConfig>,
  ): Promise<
    [
      ArtifactDeployed<RawSyntheticWarpArtifactConfig, DeployedWarpAddress>,
      SvmReceipt[],
    ]
  > {
    const receipts: SvmReceipt[] = [];
    const tokenConfig = artifact.config;
    assert(
      tokenConfig.metadataUri !== undefined,
      'metadataUri is required for Solana synthetic token deployments',
    );

    const { programAddress, receipts: deployReceipts } = await resolveProgram(
      this.config.program,
      this.svmSigner,
      this.rpc,
    );
    receipts.push(...deployReceipts);

    const { address: tokenPda } = await deriveHyperlaneTokenPda(programAddress);
    const { address: dispatchAuthPda } =
      await deriveMailboxDispatchAuthorityPda(programAddress);
    const { address: mintPda } = await deriveSyntheticMintPda(programAddress);
    const { address: ataPayerPda } = await deriveAtaPayerPda(programAddress);

    const initData = buildBaseInitData(
      tokenConfig,
      this.config.igpProgramId,
      tokenConfig.decimals,
      scaleToRemoteDecimals(tokenConfig.decimals, tokenConfig.scale),
    );

    // Init instruction: base accounts + mintPda + ataPayerPda.
    // Payer must be WRITABLE_SIGNER to fund account creation.
    const initIx = buildInstruction(
      programAddress,
      [
        readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
        writableAccount(tokenPda),
        writableAccount(dispatchAuthPda),
        writableSigner(this.svmSigner.signer),
        writableAccount(mintPda),
        writableAccount(ataPayerPda),
      ],
      encodeTokenProgramInstruction({ kind: 'init', value: initData }),
    );

    const initMetadataPtrIx = createInitializeMetadataPointerInstruction(
      mintPda,
      this.svmSigner.signer.address,
      mintPda,
    );
    const initMintIx = createInitializeMint2Instruction(
      mintPda,
      tokenConfig.decimals,
      this.svmSigner.signer.address,
    );

    receipts.push(
      await this.svmSigner.send({
        instructions: [initIx, initMetadataPtrIx, initMintIx],
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

    // Initialize Token 2022 metadata.
    if (tokenConfig.name && tokenConfig.symbol) {
      // Fund mint account to cover metadata account rent.
      const fundMintIx: SvmInstruction = buildInstruction(
        SYSTEM_PROGRAM_ADDRESS,
        [writableSigner(this.svmSigner.signer), writableAccount(mintPda)],
        concatBytes(
          u8(2), // SystemProgram::Transfer discriminator
          new Uint8Array(4), // 4-byte padding before the u64 amount
          new Uint8Array(new BigUint64Array([BigInt(1_000_000)]).buffer),
        ),
      );

      const initMetadataIx = createInitializeMetadataInstruction(
        mintPda,
        this.svmSigner.signer.address,
        this.svmSigner.signer,
        tokenConfig.name,
        tokenConfig.symbol,
        tokenConfig.metadataUri,
      );

      receipts.push(
        await this.svmSigner.send({
          instructions: [fundMintIx, initMetadataIx],
          skipPreflight: true,
        }),
      );
    }

    // Transfer mint authority to mintPda so the program owns minting.
    const setAuthorityIx = createSetAuthorityInstruction(
      mintPda,
      this.svmSigner.signer,
      mintPda,
    );
    receipts.push(
      await this.svmSigner.send({
        instructions: [setAuthorityIx],
        skipPreflight: true,
      }),
    );

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
      RawSyntheticWarpArtifactConfig,
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
        annotation: `Update synthetic token ${programId}`,
      },
    ];
  }
}
