import {
  type ArtifactDeployed,
  type ArtifactNew,
  ArtifactState,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedWarpAddress,
  type RawCollateralWarpArtifactConfig,
  type RawNativeWarpArtifactConfig,
  type RawSyntheticWarpArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/warp';
import { assert, isNullish } from '@hyperlane-xyz/utils';
import {
  type Address,
  getAddressEncoder,
  address as parseAddress,
  type TransactionSigner,
} from '@solana/kit';

import { getMintDecimals } from '../accounts/mint.js';
import { decodeHyperlaneTokenRouteAccount } from '../accounts/token.js';
import type { SvmSigner } from '../clients/signer.js';
import { concatBytes, u32le, u64le, u8 } from '../codecs/binary.js';
import {
  DEFAULT_COMPUTE_UNITS,
  RENT_SYSVAR_ADDRESS,
  SPL_TOKEN_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
} from '../constants.js';
import {
  getCreateRouteInstruction,
  getEnrollRemoteRoutersForRouteInstruction,
  getSetDestinationGasConfigsForRouteInstruction,
} from '../instructions/factory-token.js';
import {
  buildInstruction,
  readonlyAccount,
  readonlySigner,
  writableAccount,
  writableSigner,
  writableSignerAddress,
} from '../instructions/utils.js';
import {
  deriveRouteAtaPayerPda,
  deriveRouteEscrowPda,
  deriveRouteMintPda,
  deriveRouteNativeCollateralPda,
  deriveRoutePda,
  deriveRouterLookupPda,
} from '../pda.js';
import type {
  AnnotatedSvmTransaction,
  SvmInstruction,
  SvmReceipt,
  SvmRpc,
} from '../types.js';

import { routerHexToBytes } from './warp-query.js';

async function readFactoryRouteAccount(
  rpc: SvmRpc,
  routeAddress: string,
): Promise<{ salt: Uint8Array } | null> {
  const acct = await rpc
    .getAccountInfo(parseAddress(routeAddress), { encoding: 'base64' })
    .send();
  if (!acct.value) return null;
  const raw = Buffer.from(acct.value.data[0] as string, 'base64');
  return decodeHyperlaneTokenRouteAccount(raw);
}
import {
  assertLocalDecimals,
  buildBaseInitData,
  MAX_GAS_CONFIGS_PER_TX,
  scaleToRemoteDecimals,
} from './warp-tx.js';

const MAX_ROUTERS_PER_TX = 20;

const METADATA_INITIALIZE_DISCRIMINATOR = new Uint8Array([
  210, 225, 30, 162, 88, 184, 77, 141,
]);

const SOL_DECIMALS = 9;

const addressEncoder = getAddressEncoder();

function createInitializeMetadataPointerInstruction(
  mint: Address,
  authority: Address,
  metadataAddress: Address,
): SvmInstruction {
  const data = new Uint8Array(66);
  data[0] = 39;
  data[1] = 0;
  data.set(addressEncoder.encode(authority), 2);
  data.set(addressEncoder.encode(metadataAddress), 34);
  return buildInstruction(
    TOKEN_2022_PROGRAM_ADDRESS,
    [writableAccount(mint)],
    data,
  );
}

function createInitializeMint2Instruction(
  mint: Address,
  decimals: number,
  mintAuthority: Address,
): SvmInstruction {
  const data = concatBytes(
    u8(20),
    u8(decimals),
    addressEncoder.encode(mintAuthority),
    u8(0),
  );
  return buildInstruction(
    TOKEN_2022_PROGRAM_ADDRESS,
    [writableAccount(mint), readonlyAccount(RENT_SYSVAR_ADDRESS)],
    data,
  );
}

function createSetAuthorityInstruction(
  mint: Address,
  currentAuthority: TransactionSigner,
  newAuthority: Address,
): SvmInstruction {
  const data = concatBytes(
    u8(6),
    u8(0),
    u8(1),
    addressEncoder.encode(newAuthority),
  );
  return buildInstruction(
    TOKEN_2022_PROGRAM_ADDRESS,
    [writableAccount(mint), readonlySigner(currentAuthority)],
    data,
  );
}

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

async function buildFundAtaPayerPdaInstruction(
  rpc: SvmRpc,
  payer: Address,
  ataPayerPda: Address,
  targetLamports: bigint,
): Promise<SvmInstruction | undefined> {
  const balance = await rpc.getBalance(ataPayerPda).send();
  const current = BigInt(balance.value);
  if (current >= targetLamports) return undefined;
  const topUp = targetLamports - current;
  const data = new Uint8Array(12);
  data.set(u32le(2), 0);
  new DataView(data.buffer).setBigUint64(4, topUp, true);
  return buildInstruction(
    SYSTEM_PROGRAM_ADDRESS,
    [writableSignerAddress(payer), writableAccount(ataPayerPda)],
    data,
  );
}

type PostInitConfig = Pick<
  | RawSyntheticWarpArtifactConfig
  | RawCollateralWarpArtifactConfig
  | RawNativeWarpArtifactConfig,
  'remoteRouters' | 'destinationGas'
>;

async function buildFactoryPostInitAnnotatedTransactions(
  ownerAddress: Address,
  factoryProgram: Address,
  salt: Uint8Array,
  config: PostInitConfig,
): Promise<AnnotatedSvmTransaction[]> {
  const txs: AnnotatedSvmTransaction[] = [];

  const routerEntries = Object.entries(config.remoteRouters);
  for (let i = 0; i < routerEntries.length; i += MAX_ROUTERS_PER_TX) {
    const batch = routerEntries.slice(i, i + MAX_ROUTERS_PER_TX);
    const routerConfigs = batch.map(([domain, router]) => ({
      domain: parseInt(domain),
      router: routerHexToBytes(router.address),
    }));
    const lookupPdas = await Promise.all(
      routerConfigs.map(({ domain, router }) =>
        deriveRouterLookupPda(factoryProgram, domain, router).then(
          ({ address }) => address,
        ),
      ),
    );
    txs.push({
      feePayer: ownerAddress,
      instructions: [
        await getEnrollRemoteRoutersForRouteInstruction(
          factoryProgram,
          ownerAddress,
          salt,
          routerConfigs,
          lookupPdas,
        ),
      ],
      annotation: 'EnrollRemoteRoutersForRoute',
    });
  }

  const gasEntries = Object.entries(config.destinationGas);
  for (let i = 0; i < gasEntries.length; i += MAX_GAS_CONFIGS_PER_TX) {
    const batch = gasEntries.slice(i, i + MAX_GAS_CONFIGS_PER_TX);
    txs.push({
      feePayer: ownerAddress,
      instructions: [
        await getSetDestinationGasConfigsForRouteInstruction(
          factoryProgram,
          ownerAddress,
          salt,
          batch.map(([domain, gas]) => ({
            domain: parseInt(domain),
            gas: BigInt(gas),
          })),
        ),
      ],
      annotation: 'SetDestinationGasConfigsForRoute',
    });
  }

  return txs;
}

async function applyFactoryPostInitConfig(
  signer: SvmSigner,
  factoryProgram: Address,
  salt: Uint8Array,
  config: PostInitConfig,
): Promise<SvmReceipt[]> {
  const txs = await buildFactoryPostInitAnnotatedTransactions(
    signer.signer.address,
    factoryProgram,
    salt,
    config,
  );
  const receipts: SvmReceipt[] = [];
  for (const tx of txs) {
    receipts.push(await signer.send(tx));
  }
  return receipts;
}

// ── Synthetic ─────────────────────────────────────────────────────────────────

export class SvmFactorySyntheticTokenWriter implements ArtifactWriter<
  RawSyntheticWarpArtifactConfig,
  DeployedWarpAddress
> {
  constructor(
    private readonly rpc: SvmRpc,
    private readonly svmSigner: SvmSigner,
    private readonly factoryProgram: Address,
    private readonly ataPayerFundingAmount: bigint,
  ) {}

  enrollmentAddress(): string {
    return this.factoryProgram.toString();
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

    assertLocalDecimals(tokenConfig.decimals);
    const remoteDecimals = scaleToRemoteDecimals(
      tokenConfig.decimals,
      tokenConfig.scale,
    );

    const salt = crypto.getRandomValues(new Uint8Array(32));

    const { address: mintPda } = await deriveRouteMintPda(
      this.factoryProgram,
      salt,
    );
    const { address: ataPayerPda } = await deriveRouteAtaPayerPda(
      this.factoryProgram,
      salt,
    );

    const initData = await buildBaseInitData(
      tokenConfig,
      tokenConfig.decimals,
      remoteDecimals,
    );

    const createRouteIx = await getCreateRouteInstruction(
      this.factoryProgram,
      this.svmSigner.signer,
      { salt, ...initData },
      [writableAccount(mintPda), writableAccount(ataPayerPda)],
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
        instructions: [createRouteIx, initMetadataPtrIx, initMintIx],
        computeUnits: DEFAULT_COMPUTE_UNITS,
        skipPreflight: true,
      }),
    );

    const encoder = new TextEncoder();
    const nameLen = encoder.encode(tokenConfig.name).length;
    const symbolLen = encoder.encode(tokenConfig.symbol).length;
    const uriLen = encoder.encode(tokenConfig.metadataUri).length;
    const metadataSize =
      4 + 32 + 32 + (4 + nameLen) + (4 + symbolLen) + (4 + uriLen) + 4;
    const metadataRent = await this.rpc
      .getMinimumBalanceForRentExemption(BigInt(metadataSize))
      .send();

    const fundMintIx: SvmInstruction = buildInstruction(
      SYSTEM_PROGRAM_ADDRESS,
      [writableSigner(this.svmSigner.signer), writableAccount(mintPda)],
      concatBytes(u32le(2), u64le(metadataRent)),
    );

    const initMetadataIx = createInitializeMetadataInstruction(
      mintPda,
      this.svmSigner.signer.address,
      this.svmSigner.signer,
      tokenConfig.name,
      tokenConfig.symbol,
      tokenConfig.metadataUri,
    );

    const setAuthorityIx = createSetAuthorityInstruction(
      mintPda,
      this.svmSigner.signer,
      mintPda,
    );

    receipts.push(
      await this.svmSigner.send({
        instructions: [fundMintIx, initMetadataIx, setAuthorityIx],
        skipPreflight: true,
      }),
    );

    const fundAtaPayerIx = await buildFundAtaPayerPdaInstruction(
      this.rpc,
      this.svmSigner.signer.address,
      ataPayerPda,
      this.ataPayerFundingAmount,
    );
    if (fundAtaPayerIx) {
      receipts.push(
        await this.svmSigner.send({ instructions: [fundAtaPayerIx] }),
      );
    }

    receipts.push(
      ...(await applyFactoryPostInitConfig(
        this.svmSigner,
        this.factoryProgram,
        salt,
        tokenConfig,
      )),
    );

    const { address: routePda } = await deriveRoutePda(
      this.factoryProgram,
      salt,
    );

    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        config: tokenConfig,
        deployed: { address: routePda, collateralAddress: mintPda.toString() },
      },
      receipts,
    ];
  }

  async read(
    _address: string,
  ): Promise<
    ArtifactDeployed<RawSyntheticWarpArtifactConfig, DeployedWarpAddress>
  > {
    throw new Error('Read not supported for factory synthetic routes');
  }

  async update(
    artifact: ArtifactDeployed<
      RawSyntheticWarpArtifactConfig,
      DeployedWarpAddress
    >,
  ): Promise<AnnotatedSvmTransaction[]> {
    const routeData = await readFactoryRouteAccount(
      this.rpc,
      artifact.deployed.address,
    );
    assert(
      routeData !== null,
      `Factory route account not found: ${artifact.deployed.address}`,
    );
    return buildFactoryPostInitAnnotatedTransactions(
      this.svmSigner.signer.address,
      this.factoryProgram,
      routeData.salt,
      artifact.config,
    );
  }
}

// ── Collateral ────────────────────────────────────────────────────────────────

export class SvmFactoryCollateralTokenWriter implements ArtifactWriter<
  RawCollateralWarpArtifactConfig,
  DeployedWarpAddress
> {
  constructor(
    private readonly rpc: SvmRpc,
    private readonly svmSigner: SvmSigner,
    private readonly factoryProgram: Address,
    private readonly ataPayerFundingAmount: bigint,
  ) {}

  enrollmentAddress(): string {
    return this.factoryProgram.toString();
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

    const collateralMint = parseAddress(tokenConfig.token);
    const mintInfo = await this.rpc
      .getAccountInfo(collateralMint, { encoding: 'base64' })
      .send();
    assert(
      !isNullish(mintInfo.value),
      `Mint account not found: ${collateralMint}`,
    );
    const splProgram = parseAddress(mintInfo.value.owner);
    assert(
      splProgram === SPL_TOKEN_PROGRAM_ADDRESS ||
        splProgram === TOKEN_2022_PROGRAM_ADDRESS,
      `Mint ${collateralMint} is not owned by SPL Token or Token-2022`,
    );
    const mintRawData = Buffer.from(mintInfo.value.data[0] as string, 'base64');
    const localDecimals = getMintDecimals(mintRawData);
    assertLocalDecimals(localDecimals);
    const remoteDecimals = scaleToRemoteDecimals(
      localDecimals,
      tokenConfig.scale,
    );

    const salt = crypto.getRandomValues(new Uint8Array(32));

    const { address: escrowPda } = await deriveRouteEscrowPda(
      this.factoryProgram,
      salt,
    );
    const { address: ataPayerPda } = await deriveRouteAtaPayerPda(
      this.factoryProgram,
      salt,
    );

    const initData = await buildBaseInitData(
      tokenConfig,
      localDecimals,
      remoteDecimals,
    );

    const createRouteIx = await getCreateRouteInstruction(
      this.factoryProgram,
      this.svmSigner.signer,
      { salt, ...initData },
      [
        readonlyAccount(splProgram),
        readonlyAccount(collateralMint),
        readonlyAccount(RENT_SYSVAR_ADDRESS),
        writableAccount(escrowPda),
        writableAccount(ataPayerPda),
      ],
    );

    receipts.push(
      await this.svmSigner.send({
        instructions: [createRouteIx],
        computeUnits: DEFAULT_COMPUTE_UNITS,
        skipPreflight: true,
      }),
    );

    const fundAtaPayerIx = await buildFundAtaPayerPdaInstruction(
      this.rpc,
      this.svmSigner.signer.address,
      ataPayerPda,
      this.ataPayerFundingAmount,
    );
    if (fundAtaPayerIx) {
      receipts.push(
        await this.svmSigner.send({ instructions: [fundAtaPayerIx] }),
      );
    }

    receipts.push(
      ...(await applyFactoryPostInitConfig(
        this.svmSigner,
        this.factoryProgram,
        salt,
        tokenConfig,
      )),
    );

    const { address: routePda } = await deriveRoutePda(
      this.factoryProgram,
      salt,
    );

    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        config: { ...tokenConfig, decimals: localDecimals },
        deployed: { address: routePda },
      },
      receipts,
    ];
  }

  async read(
    _address: string,
  ): Promise<
    ArtifactDeployed<RawCollateralWarpArtifactConfig, DeployedWarpAddress>
  > {
    throw new Error('Read not supported for factory collateral routes');
  }

  async update(
    artifact: ArtifactDeployed<
      RawCollateralWarpArtifactConfig,
      DeployedWarpAddress
    >,
  ): Promise<AnnotatedSvmTransaction[]> {
    const routeData = await readFactoryRouteAccount(
      this.rpc,
      artifact.deployed.address,
    );
    assert(
      routeData !== null,
      `Factory route account not found: ${artifact.deployed.address}`,
    );
    return buildFactoryPostInitAnnotatedTransactions(
      this.svmSigner.signer.address,
      this.factoryProgram,
      routeData.salt,
      artifact.config,
    );
  }
}

// ── Native ────────────────────────────────────────────────────────────────────

export class SvmFactoryNativeTokenWriter implements ArtifactWriter<
  RawNativeWarpArtifactConfig,
  DeployedWarpAddress
> {
  constructor(
    private readonly rpc: SvmRpc,
    private readonly svmSigner: SvmSigner,
    private readonly factoryProgram: Address,
  ) {}

  enrollmentAddress(): string {
    return this.factoryProgram.toString();
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
    const tokenConfig = artifact.config;

    const localDecimals = tokenConfig.decimals ?? SOL_DECIMALS;
    assertLocalDecimals(localDecimals);
    const remoteDecimals = scaleToRemoteDecimals(
      localDecimals,
      tokenConfig.scale,
    );

    const salt = crypto.getRandomValues(new Uint8Array(32));

    const { address: nativeCollateralPda } =
      await deriveRouteNativeCollateralPda(this.factoryProgram, salt);

    const initData = await buildBaseInitData(
      tokenConfig,
      localDecimals,
      remoteDecimals,
    );

    const createRouteIx = await getCreateRouteInstruction(
      this.factoryProgram,
      this.svmSigner.signer,
      { salt, ...initData },
      [writableAccount(nativeCollateralPda)],
    );

    receipts.push(
      await this.svmSigner.send({
        instructions: [createRouteIx],
        computeUnits: DEFAULT_COMPUTE_UNITS,
        skipPreflight: true,
      }),
    );

    receipts.push(
      ...(await applyFactoryPostInitConfig(
        this.svmSigner,
        this.factoryProgram,
        salt,
        tokenConfig,
      )),
    );

    const { address: routePda } = await deriveRoutePda(
      this.factoryProgram,
      salt,
    );

    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        config: { ...tokenConfig, decimals: localDecimals },
        deployed: { address: routePda },
      },
      receipts,
    ];
  }

  async read(
    _address: string,
  ): Promise<
    ArtifactDeployed<RawNativeWarpArtifactConfig, DeployedWarpAddress>
  > {
    throw new Error('Read not supported for factory native routes');
  }

  async update(
    artifact: ArtifactDeployed<
      RawNativeWarpArtifactConfig,
      DeployedWarpAddress
    >,
  ): Promise<AnnotatedSvmTransaction[]> {
    const routeData = await readFactoryRouteAccount(
      this.rpc,
      artifact.deployed.address,
    );
    assert(
      routeData !== null,
      `Factory route account not found: ${artifact.deployed.address}`,
    );
    return buildFactoryPostInitAnnotatedTransactions(
      this.svmSigner.signer.address,
      this.factoryProgram,
      routeData.salt,
      artifact.config,
    );
  }
}
