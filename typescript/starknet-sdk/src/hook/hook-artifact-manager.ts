import { AltVM, ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk';
import { ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  ArtifactDeployed,
  ArtifactNew,
  ArtifactReader,
  ArtifactState,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedHookAddress,
  DeployedHookArtifact,
  HookType,
  IRawHookArtifactManager,
  RawHookArtifactConfigs,
  throwUnsupportedHookType,
} from '@hyperlane-xyz/provider-sdk/hook';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import { assert, eqAddressStarknet, rootLogger } from '@hyperlane-xyz/utils';
import { hash } from 'starknet';

import { StarknetProvider } from '../clients/provider.js';
import { StarknetSigner } from '../clients/signer.js';
import {
  StarknetContractName,
  callContract,
  getFeeTokenAddress,
  getStarknetContract,
  normalizeStarknetAddressSafe,
  populateInvokeTx,
  toBigInt,
} from '../contracts.js';
import { StarknetDeployTx } from '../types.js';

const STARKNET_STORAGE_ADDRESS_BOUND = (1n << 251n) - 256n;
const logger = rootLogger.child({ module: 'starknet-hook-artifact-manager' });
const MAX_PROTOCOL_FEE_STORAGE_KEYS = [
  'max_protocol_fee',
  '_max_protocol_fee',
].map((name) => hash.starknetKeccak(name) % STARKNET_STORAGE_ADDRESS_BOUND);

function shouldFallbackStorageRead(error: unknown): boolean {
  const code =
    error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
  if (code === -32601) return true;

  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : String(
            error && typeof error === 'object'
              ? Reflect.get(error, 'message')
              : error,
          );
  const normalizedMessage = message.toLowerCase();

  return [
    'method not found',
    'not supported',
    'unsupported',
    'not implemented',
  ].some((fragment) => normalizedMessage.includes(fragment));
}

async function readUint256Storage(
  provider: StarknetProvider,
  contractAddress: string,
  key: bigint,
): Promise<bigint | undefined> {
  try {
    const rawProvider = provider.getRawProvider();
    const [low, high] = await Promise.all([
      rawProvider.getStorageAt(contractAddress, `0x${key.toString(16)}`),
      rawProvider.getStorageAt(contractAddress, `0x${(key + 1n).toString(16)}`),
    ]);
    return toBigInt(low) + (toBigInt(high) << 128n);
  } catch (error: unknown) {
    if (!shouldFallbackStorageRead(error)) {
      throw error;
    }

    logger.warn(
      {
        contractAddress,
        key: `0x${key.toString(16)}`,
        error,
      },
      'Falling back to lossy Starknet protocolFee max read after unsupported storage lookup',
    );
    return undefined;
  }
}

async function readProtocolFeeMaxFromStorage(
  provider: StarknetProvider,
  contractAddress: string,
  protocolFee: bigint,
): Promise<bigint | undefined> {
  // Different Starknet contract builds have used different storage keys for
  // max_protocol_fee. Accept any candidate that is at least the live
  // protocolFee, prefer a single non-zero value over zero sentinels, and only
  // fall back to all candidates when multiple non-zero slots are populated.
  const candidates = (
    await Promise.all(
      MAX_PROTOCOL_FEE_STORAGE_KEYS.map((key) =>
        readUint256Storage(provider, contractAddress, key),
      ),
    )
  ).filter(
    (value): value is bigint => value !== undefined && value >= protocolFee,
  );

  if (candidates.length === 0) return undefined;

  const nonZeroCandidates = candidates.filter((value) => value > 0n);
  const relevantCandidates =
    nonZeroCandidates.length === 1 ? nonZeroCandidates : candidates;
  const uniqueValues = [
    ...new Set(relevantCandidates.map((value) => value.toString())),
  ];

  if (uniqueValues.length === 1) {
    return BigInt(uniqueValues[0]!);
  }

  return undefined;
}

function createUnsupportedStarknetHookReader<
  T extends keyof RawHookArtifactConfigs,
>(type: T): ArtifactReader<RawHookArtifactConfigs[T], DeployedHookAddress> {
  return {
    read: async () => {
      return throwUnsupportedHookType(type, 'Starknet');
    },
  };
}

function createUnsupportedStarknetHookWriter<
  T extends keyof RawHookArtifactConfigs,
>(type: T): ArtifactWriter<RawHookArtifactConfigs[T], DeployedHookAddress> {
  return {
    read: async () => {
      return throwUnsupportedHookType(type, 'Starknet');
    },
    create: async () => {
      return throwUnsupportedHookType(type, 'Starknet');
    },
    update: async () => {
      return throwUnsupportedHookType(type, 'Starknet');
    },
  };
}

class StarknetMerkleTreeHookReader implements ArtifactReader<
  RawHookArtifactConfigs['merkleTreeHook'],
  DeployedHookAddress
> {
  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<
      RawHookArtifactConfigs['merkleTreeHook'],
      DeployedHookAddress
    >
  > {
    return {
      artifactState: ArtifactState.DEPLOYED,
      config: { type: AltVM.HookType.MERKLE_TREE },
      deployed: { address: normalizeStarknetAddressSafe(address) },
    };
  }
}

class StarknetMerkleTreeHookWriter
  extends StarknetMerkleTreeHookReader
  implements
    ArtifactWriter<
      RawHookArtifactConfigs['merkleTreeHook'],
      DeployedHookAddress
    >
{
  constructor(
    private readonly signer: StarknetSigner,
    private readonly mailboxAddress: string,
  ) {
    super();
  }

  async create(
    artifact: ArtifactNew<RawHookArtifactConfigs['merkleTreeHook']>,
  ): Promise<
    [
      ArtifactDeployed<
        RawHookArtifactConfigs['merkleTreeHook'],
        DeployedHookAddress
      >,
      TxReceipt[],
    ]
  > {
    const deployed = await this.signer.createMerkleTreeHook({
      mailboxAddress: this.mailboxAddress,
    });

    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        config: artifact.config,
        deployed: { address: deployed.hookAddress },
      },
      [],
    ];
  }

  async update(
    _artifact: ArtifactDeployed<
      RawHookArtifactConfigs['merkleTreeHook'],
      DeployedHookAddress
    >,
  ): Promise<AnnotatedTx[]> {
    return [];
  }
}

class StarknetNoopHookReader implements ArtifactReader<
  RawHookArtifactConfigs['unknownHook'],
  DeployedHookAddress
> {
  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<RawHookArtifactConfigs['unknownHook'], DeployedHookAddress>
  > {
    return {
      artifactState: ArtifactState.DEPLOYED,
      config: { type: 'unknownHook' },
      deployed: { address: normalizeStarknetAddressSafe(address) },
    };
  }
}

class StarknetNoopHookWriter
  extends StarknetNoopHookReader
  implements
    ArtifactWriter<RawHookArtifactConfigs['unknownHook'], DeployedHookAddress>
{
  constructor(private readonly signer: StarknetSigner) {
    super();
  }

  async create(
    artifact: ArtifactNew<RawHookArtifactConfigs['unknownHook']>,
  ): Promise<
    [
      ArtifactDeployed<
        RawHookArtifactConfigs['unknownHook'],
        DeployedHookAddress
      >,
      TxReceipt[],
    ]
  > {
    const deployed = await this.signer.createNoopHook({ mailboxAddress: '' });

    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        config: artifact.config,
        deployed: { address: deployed.hookAddress },
      },
      [],
    ];
  }

  async update(
    _artifact: ArtifactDeployed<
      RawHookArtifactConfigs['unknownHook'],
      DeployedHookAddress
    >,
  ): Promise<AnnotatedTx[]> {
    return [];
  }
}

class StarknetProtocolFeeHookReader implements ArtifactReader<
  RawHookArtifactConfigs['protocolFee'],
  DeployedHookAddress
> {
  constructor(
    protected readonly chainMetadata: ChainMetadataForAltVM,
    protected readonly provider: StarknetProvider,
  ) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<RawHookArtifactConfigs['protocolFee'], DeployedHookAddress>
  > {
    const normalizedAddress = normalizeStarknetAddressSafe(address);
    const hook = getStarknetContract(
      StarknetContractName.PROTOCOL_FEE,
      normalizedAddress,
      this.provider.getRawProvider(),
    );

    const [owner, beneficiary, protocolFee] = await Promise.all([
      callContract(hook, 'owner'),
      callContract(hook, 'get_beneficiary'),
      callContract(hook, 'get_protocol_fee'),
    ]);

    const ownerAddress = normalizeStarknetAddressSafe(owner);
    const beneficiaryAddress = normalizeStarknetAddressSafe(beneficiary);
    const protocolFeeAmount = toBigInt(protocolFee);
    const maxProtocolFee = await readProtocolFeeMaxFromStorage(
      this.provider,
      normalizedAddress,
      protocolFeeAmount,
    );
    const config: RawHookArtifactConfigs['protocolFee'] = {
      type: AltVM.HookType.PROTOCOL_FEE,
      owner: ownerAddress,
      beneficiary: beneficiaryAddress,
      maxProtocolFee: (maxProtocolFee ?? protocolFeeAmount).toString(),
      protocolFee: protocolFeeAmount.toString(),
    };
    if (maxProtocolFee === undefined) {
      // Starknet protocol_fee does not expose maxProtocolFee in its ABI.
      // If storage lookup is unavailable or ambiguous, mark the read config
      // as lossy so generic deploy logic can fail closed instead of silently
      // ignoring maxProtocolFee drift.
      Object.defineProperty(config, '__maxProtocolFeeUnknown', {
        value: true,
      });
    }

    return {
      artifactState: ArtifactState.DEPLOYED,
      config,
      deployed: { address: normalizedAddress },
    };
  }
}

class StarknetProtocolFeeHookWriter
  extends StarknetProtocolFeeHookReader
  implements
    ArtifactWriter<RawHookArtifactConfigs['protocolFee'], DeployedHookAddress>
{
  constructor(
    chainMetadata: ChainMetadataForAltVM,
    provider: StarknetProvider,
    private readonly signer: StarknetSigner,
  ) {
    super(chainMetadata, provider);
  }

  async create(
    artifact: ArtifactNew<RawHookArtifactConfigs['protocolFee']>,
  ): Promise<
    [
      ArtifactDeployed<
        RawHookArtifactConfigs['protocolFee'],
        DeployedHookAddress
      >,
      TxReceipt[],
    ]
  > {
    const tokenAddress = getFeeTokenAddress({
      chainName: this.chainMetadata.name,
      nativeDenom: this.chainMetadata.nativeToken?.denom,
    });

    const deployTx = {
      kind: 'deploy',
      contractName: StarknetContractName.PROTOCOL_FEE,
      constructorArgs: [
        artifact.config.maxProtocolFee,
        artifact.config.protocolFee,
        normalizeStarknetAddressSafe(artifact.config.beneficiary),
        normalizeStarknetAddressSafe(artifact.config.owner),
        tokenAddress,
      ],
    } satisfies StarknetDeployTx;

    const receipt = await this.signer.sendAndConfirmTransaction(deployTx);
    assert(
      receipt.contractAddress,
      'failed to deploy Starknet protocol_fee hook',
    );

    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        config: artifact.config,
        deployed: {
          address: normalizeStarknetAddressSafe(receipt.contractAddress),
        },
      },
      [receipt],
    ];
  }

  async update(
    artifact: ArtifactDeployed<
      RawHookArtifactConfigs['protocolFee'],
      DeployedHookAddress
    >,
  ): Promise<AnnotatedTx[]> {
    const current = await this.read(artifact.deployed.address);
    const maxProtocolFeeUnknown =
      // CAST: Reflect.get requires an object argument; protocolFee config is always an object here.
      Reflect.get(current.config as object, '__maxProtocolFeeUnknown') === true;
    assert(
      !maxProtocolFeeUnknown,
      'Cannot update Starknet protocolFee hook because the current maxProtocolFee is unreadable; redeploy required',
    );
    assert(
      current.config.maxProtocolFee === artifact.config.maxProtocolFee,
      'Changing maxProtocolFee requires redeploying the Starknet protocolFee hook',
    );
    const contractAddress = artifact.deployed.address;
    const contract = getStarknetContract(
      StarknetContractName.PROTOCOL_FEE,
      contractAddress,
      this.provider.getRawProvider(),
    );
    const txs: AnnotatedTx[] = [];

    if (
      !eqAddressStarknet(
        current.config.beneficiary,
        artifact.config.beneficiary,
      )
    ) {
      txs.push({
        annotation: `Updating protocol fee beneficiary for ${contractAddress}`,
        ...(await populateInvokeTx(contract, 'set_beneficiary', [
          normalizeStarknetAddressSafe(artifact.config.beneficiary),
        ])),
      });
    }

    if (current.config.protocolFee !== artifact.config.protocolFee) {
      txs.push({
        annotation: `Updating protocol fee amount for ${contractAddress}`,
        ...(await populateInvokeTx(contract, 'set_protocol_fee', [
          artifact.config.protocolFee,
        ])),
      });
    }

    if (!eqAddressStarknet(current.config.owner, artifact.config.owner)) {
      txs.push({
        annotation: `Transferring protocol fee hook ownership for ${contractAddress}`,
        ...(await populateInvokeTx(contract, 'transfer_ownership', [
          normalizeStarknetAddressSafe(artifact.config.owner),
        ])),
      });
    }

    return txs;
  }
}

export class StarknetHookArtifactManager implements IRawHookArtifactManager {
  private readonly provider: StarknetProvider;
  private readonly mailboxAddress: string;

  constructor(
    private readonly chainMetadata: ChainMetadataForAltVM,
    context?: { mailbox?: string },
  ) {
    this.provider = StarknetProvider.connect(
      (chainMetadata.rpcUrls ?? []).map(({ http }) => http),
      chainMetadata.chainId,
      { metadata: chainMetadata },
    );
    this.mailboxAddress = context?.mailbox
      ? normalizeStarknetAddressSafe(context.mailbox)
      : '';
  }

  private requireStarknetSigner(
    signer: ISigner<AnnotatedTx, TxReceipt>,
  ): StarknetSigner {
    assert(signer instanceof StarknetSigner, 'Expected StarknetSigner');
    return signer;
  }

  async readHook(address: string): Promise<DeployedHookArtifact> {
    const hookType = await this.provider.getHookType({
      hookAddress: address,
    });

    switch (hookType) {
      case AltVM.HookType.CUSTOM:
        return this.createReader('unknownHook').read(address);
      case AltVM.HookType.MERKLE_TREE:
        return this.createReader(AltVM.HookType.MERKLE_TREE).read(address);
      case AltVM.HookType.PROTOCOL_FEE:
        return this.createReader(AltVM.HookType.PROTOCOL_FEE).read(address);
      default:
        return throwUnsupportedHookType(hookType, 'Starknet');
    }
  }

  createReader<T extends HookType>(
    type: T,
  ): ArtifactReader<RawHookArtifactConfigs[T], DeployedHookAddress> {
    const readers: Partial<{
      [K in HookType]: ArtifactReader<
        RawHookArtifactConfigs[K],
        DeployedHookAddress
      >;
    }> = {
      merkleTreeHook: new StarknetMerkleTreeHookReader(),
      interchainGasPaymaster: createUnsupportedStarknetHookReader(
        AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
      ),
      protocolFee: new StarknetProtocolFeeHookReader(
        this.chainMetadata,
        this.provider,
      ),
      unknownHook: new StarknetNoopHookReader(),
    };
    const reader = readers[type];
    if (!reader) {
      return throwUnsupportedHookType(type, 'Starknet');
    }
    return reader;
  }

  createWriter<T extends HookType>(
    type: T,
    signer: ISigner<AnnotatedTx, TxReceipt>,
  ): ArtifactWriter<RawHookArtifactConfigs[T], DeployedHookAddress> {
    const starknetSigner = this.requireStarknetSigner(signer);
    assert(
      this.mailboxAddress || type !== AltVM.HookType.MERKLE_TREE,
      'mailbox address required for Starknet merkle tree hook deployment',
    );

    const writers: Partial<{
      [K in HookType]: ArtifactWriter<
        RawHookArtifactConfigs[K],
        DeployedHookAddress
      >;
    }> = {
      merkleTreeHook: new StarknetMerkleTreeHookWriter(
        starknetSigner,
        this.mailboxAddress,
      ),
      interchainGasPaymaster: createUnsupportedStarknetHookWriter(
        AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
      ),
      protocolFee: new StarknetProtocolFeeHookWriter(
        this.chainMetadata,
        this.provider,
        starknetSigner,
      ),
      unknownHook: new StarknetNoopHookWriter(starknetSigner),
    };
    const writer = writers[type];
    if (!writer) {
      return throwUnsupportedHookType(type, 'Starknet');
    }
    return writer;
  }
}
