import {
  AccountRole,
  type Address,
  type Rpc,
  type SolanaRpcApi,
  address,
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
import { ZERO_ADDRESS_HEX_32, assert, isNullish } from '@hyperlane-xyz/utils';

import { deployProgram } from '../deploy/program-deployer.js';
import { getTokenInstructionProxyEncoder } from '../generated/types/index.js';
import type { InitProxyArgs } from '../generated/types/index.js';
import type { SvmSigner } from '../signer.js';
import type { AnnotatedSvmTransaction, SvmInstruction } from '../types.js';

import {
  RENT_SYSVAR,
  SYSTEM_PROGRAM_ID,
  prependDiscriminator,
} from './constants.js';
import type { SvmWarpTokenConfig } from './types.js';
import {
  fetchSyntheticToken,
  getDispatchAuthorityPda,
  getHyperlaneTokenPda,
  routerBytesToHex,
} from './warp-query.js';
import {
  applyPostInitConfig,
  buildBaseInitArgs,
  computeWarpTokenUpdateInstructions,
} from './warp-tx.js';

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

export function createInitializeMetadataPointerInstruction(
  mint: Address,
  authority: Address | null,
  metadataAddress: Address | null,
): SvmInstruction {
  const addressEncoder = getAddressEncoder();
  const data = new Uint8Array(66);
  data[0] = 39;
  data[1] = 0;
  if (authority) data.set(addressEncoder.encode(authority), 2);
  if (metadataAddress) data.set(addressEncoder.encode(metadataAddress), 34);
  return {
    programAddress: TOKEN_2022_PROGRAM_ID.toBase58() as Address,
    accounts: [{ address: mint, role: AccountRole.READONLY }],
    data,
  };
}

export function createInitializeMint2Instruction(
  mint: Address,
  decimals: number,
  mintAuthority: Address,
): SvmInstruction {
  const addressEncoder = getAddressEncoder();
  const data = new Uint8Array(35);
  data[0] = 20;
  data[1] = decimals;
  data.set(addressEncoder.encode(mintAuthority), 2);
  data[34] = 0;
  return {
    programAddress: TOKEN_2022_PROGRAM_ID.toBase58() as Address,
    accounts: [
      { address: mint, role: AccountRole.WRITABLE },
      { address: RENT_SYSVAR, role: AccountRole.READONLY },
    ],
    data,
  };
}

function createSetAuthorityInstruction(
  mint: Address,
  currentAuthority: Address,
  newAuthority: Address,
): SvmInstruction {
  const addressEncoder = getAddressEncoder();
  const data = new Uint8Array(35);
  data[0] = 6;
  data[1] = 0;
  data[2] = 1;
  data.set(addressEncoder.encode(newAuthority), 3);
  return {
    programAddress: TOKEN_2022_PROGRAM_ID.toBase58() as Address,
    accounts: [
      { address: mint, role: AccountRole.WRITABLE },
      { address: currentAuthority, role: AccountRole.READONLY_SIGNER },
    ],
    data,
  };
}

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
      { address: mint, role: AccountRole.WRITABLE },
      { address: updateAuthority, role: AccountRole.READONLY },
      { address: mint, role: AccountRole.READONLY },
      { address: mintAuthority, role: AccountRole.READONLY_SIGNER },
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
      { address: mintPda, role: AccountRole.WRITABLE },
      { address: ataPayerPda, role: AccountRole.WRITABLE },
    ],
    data,
  };
}

async function fetchTokenMetadata(
  rpcUrl: string,
  programId: Address,
): Promise<{ name: string; symbol: string; uri: string } | null> {
  const [mintPda] = await getSyntheticMintPda(programId);
  try {
    const connection = new Connection(rpcUrl, 'confirmed');
    const mintPubkey = new PublicKey(mintPda);
    const mintInfo = await getMint(
      connection,
      mintPubkey,
      'confirmed',
      TOKEN_2022_PROGRAM_ID,
    );
    const metadataPointer = getMetadataPointerState(mintInfo);
    if (!metadataPointer?.metadataAddress) return null;
    const metadata = await getTokenMetadata(
      connection,
      metadataPointer.metadataAddress,
      'confirmed',
      TOKEN_2022_PROGRAM_ID,
    );
    return metadata
      ? { name: metadata.name, symbol: metadata.symbol, uri: metadata.uri }
      : null;
  } catch {
    return null;
  }
}

export class SvmSyntheticTokenReader
  implements ArtifactReader<RawSyntheticWarpArtifactConfig, DeployedWarpAddress>
{
  constructor(
    protected readonly rpc: Rpc<SolanaRpcApi>,
    protected readonly rpcUrl: string,
  ) {}

  async read(
    programAddress: string,
  ): Promise<
    ArtifactDeployed<RawSyntheticWarpArtifactConfig, DeployedWarpAddress>
  > {
    const programId = address(programAddress);
    const token = await fetchSyntheticToken(this.rpc, programId);
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
  extends SvmSyntheticTokenReader
  implements
    ArtifactWriter<SyntheticDeployConfigWithMetadata, DeployedWarpAddress>
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
    artifact: ArtifactNew<SyntheticDeployConfigWithMetadata>,
  ): Promise<
    [
      ArtifactDeployed<SyntheticDeployConfigWithMetadata, DeployedWarpAddress>,
      import('../types.js').SvmReceipt[],
    ]
  > {
    const receipts: import('../types.js').SvmReceipt[] = [];
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
    const [mintPda] = await getSyntheticMintPda(programId);
    const [ataPayerPda] = await getAtaPayerPda(programId);

    // Step 3: Initialize
    const initArgs = buildBaseInitArgs(
      config,
      this.config.igpProgramId,
      config.decimals,
      config.decimals,
    );

    const initIx = buildSyntheticTokenInitInstruction(
      programId,
      this.signer.address,
      tokenPda,
      dispatchAuthPda,
      mintPda,
      ataPayerPda,
      initArgs,
    );
    const initMetadataPtrIx = createInitializeMetadataPointerInstruction(
      mintPda,
      this.signer.address,
      mintPda,
    );
    const initMintIx = createInitializeMint2Instruction(
      mintPda,
      config.decimals,
      this.signer.address,
    );

    const initReceipt = await this.signer.signAndSend(this.rpc, {
      instructions: [initIx, initMetadataPtrIx, initMintIx],
      computeUnits: 400_000,
    });
    receipts.push(initReceipt);

    await new Promise((r) => setTimeout(r, 2000));

    const tokenCheck = await fetchSyntheticToken(this.rpc, programId);
    if (isNullish(tokenCheck)) {
      throw new Error(`Init failed - token not created at ${programId}`);
    }

    // Step 4: Initialize metadata
    if (config.name && config.symbol) {
      const fundMintData = new Uint8Array(12);
      fundMintData[0] = 2;
      new DataView(fundMintData.buffer).setBigUint64(
        4,
        BigInt(1_000_000),
        true,
      );
      const fundMintIx: SvmInstruction = {
        programAddress: SYSTEM_PROGRAM_ID,
        accounts: [
          { address: this.signer.address, role: AccountRole.WRITABLE_SIGNER },
          { address: mintPda, role: AccountRole.WRITABLE },
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
      receipts.push(
        await this.signer.signAndSend(this.rpc, {
          instructions: [fundMintIx, initMetadataIx],
        }),
      );
    }

    // Step 5: Transfer mint authority to mint PDA
    const setAuthorityIx = createSetAuthorityInstruction(
      mintPda,
      this.signer.address,
      mintPda,
    );
    receipts.push(
      await this.signer.signAndSend(this.rpc, {
        instructions: [setAuthorityIx],
      }),
    );

    // Step 6: Configure routers, gas, ISM
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
      RawSyntheticWarpArtifactConfig,
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
        annotation: `Update synthetic token ${programId}`,
      },
    ];
  }
}
