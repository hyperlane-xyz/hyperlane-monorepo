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
} from '@hyperlane-xyz/provider-sdk/hook';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import { assert, eqAddressStarknet } from '@hyperlane-xyz/utils';

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

class StarknetMerkleTreeHookReader
  implements
    ArtifactReader<
      RawHookArtifactConfigs['merkleTreeHook'],
      DeployedHookAddress
    >
{
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

class StarknetProtocolFeeHookReader
  implements
    ArtifactReader<RawHookArtifactConfigs['protocolFee'], DeployedHookAddress>
{
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

    const [owner, beneficiary, maxProtocolFee, protocolFee] = await Promise.all(
      [
        callContract(hook, 'owner'),
        callContract(hook, 'get_beneficiary'),
        callContract(hook, 'get_max_protocol_fee'),
        callContract(hook, 'get_protocol_fee'),
      ],
    );

    const ownerAddress = normalizeStarknetAddressSafe(owner);
    const beneficiaryAddress = normalizeStarknetAddressSafe(beneficiary);

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: AltVM.HookType.PROTOCOL_FEE,
        owner: ownerAddress,
        beneficiary: beneficiaryAddress,
        maxProtocolFee: toBigInt(maxProtocolFee).toString(),
        protocolFee: toBigInt(protocolFee).toString(),
      },
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

  async readHook(address: string): Promise<DeployedHookArtifact> {
    const hookType = await this.provider.getHookType({ hookAddress: address });
    if (hookType === AltVM.HookType.MERKLE_TREE) {
      return this.createReader(AltVM.HookType.MERKLE_TREE).read(address);
    }

    if (hookType === AltVM.HookType.PROTOCOL_FEE) {
      return this.createReader(AltVM.HookType.PROTOCOL_FEE).read(address);
    }

    throw new Error(`Unsupported Starknet hook type: ${hookType}`);
  }

  createReader<T extends HookType>(
    type: T,
  ): ArtifactReader<RawHookArtifactConfigs[T], DeployedHookAddress> {
    const readers: {
      [K in HookType]: () => ArtifactReader<
        RawHookArtifactConfigs[K],
        DeployedHookAddress
      >;
    } = {
      merkleTreeHook: () => new StarknetMerkleTreeHookReader(),
      interchainGasPaymaster: () => {
        throw new Error(
          'interchainGasPaymaster hook type is unsupported on Starknet',
        );
      },
      protocolFee: () =>
        new StarknetProtocolFeeHookReader(this.chainMetadata, this.provider),
    };

    const readerFactory = readers[type];
    if (!readerFactory) {
      throw new Error(`Unsupported Starknet hook type: ${type}`);
    }
    return readerFactory() as ArtifactReader<
      RawHookArtifactConfigs[T],
      DeployedHookAddress
    >;
  }

  createWriter<T extends HookType>(
    type: T,
    signer: ISigner<AnnotatedTx, TxReceipt>,
  ): ArtifactWriter<RawHookArtifactConfigs[T], DeployedHookAddress> {
    const starknetSigner = signer as StarknetSigner;

    const writers: {
      [K in HookType]: () => ArtifactWriter<
        RawHookArtifactConfigs[K],
        DeployedHookAddress
      >;
    } = {
      merkleTreeHook: () => {
        assert(
          this.mailboxAddress,
          'mailbox address required for Starknet merkle tree hook deployment',
        );
        return new StarknetMerkleTreeHookWriter(
          starknetSigner,
          this.mailboxAddress,
        );
      },
      interchainGasPaymaster: () => {
        throw new Error(
          'interchainGasPaymaster hook type is unsupported on Starknet',
        );
      },
      protocolFee: () =>
        new StarknetProtocolFeeHookWriter(
          this.chainMetadata,
          this.provider,
          starknetSigner,
        ),
    };

    const writerFactory = writers[type];
    if (!writerFactory) {
      throw new Error(`Unsupported Starknet hook type: ${type}`);
    }
    return writerFactory() as ArtifactWriter<
      RawHookArtifactConfigs[T],
      DeployedHookAddress
    >;
  }
}
