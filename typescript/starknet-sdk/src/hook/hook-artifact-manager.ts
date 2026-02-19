import { AltVM, type ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk';
import type { ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  type ArtifactDeployed,
  type ArtifactNew,
  type ArtifactReader,
  ArtifactState,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import type {
  DeployedHookAddress,
  DeployedHookArtifact,
  HookType,
  IRawHookArtifactManager,
  RawHookArtifactConfigs,
} from '@hyperlane-xyz/provider-sdk/hook';
import type {
  AnnotatedTx,
  TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import { eqAddressStarknet } from '@hyperlane-xyz/utils';

import { StarknetProvider } from '../clients/provider.js';
import type { StarknetSigner } from '../clients/signer.js';
import {
  StarknetContractName,
  callContract,
  getFeeTokenAddress,
  getStarknetContract,
  normalizeStarknetAddress,
  populateInvokeTx,
  toBigInt,
} from '../contracts.js';
import type { StarknetDeployTx } from '../types.js';

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
      config: {
        type: AltVM.HookType.MERKLE_TREE,
      },
      deployed: {
        address: normalizeStarknetAddress(address),
      },
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
  constructor(private readonly chainMetadata: ChainMetadataForAltVM) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<RawHookArtifactConfigs['protocolFee'], DeployedHookAddress>
  > {
    const normalizedAddress = normalizeStarknetAddress(address);
    const hook = getStarknetContract(
      StarknetContractName.PROTOCOL_FEE,
      normalizedAddress,
    );

    const [owner, beneficiary, protocolFee, maxProtocolFee] = await Promise.all(
      [
        callContract(hook, 'owner'),
        callContract(hook, 'get_beneficiary'),
        callContract(hook, 'get_protocol_fee'),
        callContract(hook, 'get_max_protocol_fee').catch(() => 0),
      ],
    );

    const tokenAddress = getFeeTokenAddress({
      chainName: this.chainMetadata.name,
      nativeDenom: this.chainMetadata.nativeToken?.denom,
    });

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: AltVM.HookType.PROTOCOL_FEE,
        owner: normalizeStarknetAddress(owner),
        beneficiary: normalizeStarknetAddress(beneficiary),
        protocolFee: toBigInt(protocolFee).toString(),
        maxProtocolFee: toBigInt(maxProtocolFee).toString(),
        tokenAddress,
      },
      deployed: {
        address: normalizedAddress,
      },
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
    private readonly signer: StarknetSigner,
  ) {
    super(chainMetadata);
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
    const deployTx = {
      kind: 'deploy',
      contractName: StarknetContractName.PROTOCOL_FEE,
      constructorArgs: [
        artifact.config.maxProtocolFee,
        artifact.config.protocolFee,
        normalizeStarknetAddress(artifact.config.beneficiary),
        normalizeStarknetAddress(artifact.config.owner),
        normalizeStarknetAddress(artifact.config.tokenAddress),
      ],
    } satisfies StarknetDeployTx;

    const receipt = await this.signer.sendAndConfirmTransaction(deployTx);

    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        config: artifact.config,
        deployed: {
          address: normalizeStarknetAddress(receipt.contractAddress),
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
    );
    const txs: AnnotatedTx[] = [];

    if (current.config.protocolFee !== artifact.config.protocolFee) {
      txs.push({
        annotation: `Updating protocol fee for ${contractAddress}`,
        ...(await populateInvokeTx(contract, 'set_protocol_fee', [
          artifact.config.protocolFee,
        ])),
      });
    }

    if (
      !eqAddressStarknet(
        current.config.beneficiary,
        artifact.config.beneficiary,
      )
    ) {
      txs.push({
        annotation: `Updating protocol fee beneficiary for ${contractAddress}`,
        ...(await populateInvokeTx(contract, 'set_beneficiary', [
          normalizeStarknetAddress(artifact.config.beneficiary),
        ])),
      });
    }

    if (!eqAddressStarknet(current.config.owner, artifact.config.owner)) {
      txs.push({
        annotation: `Transferring protocol fee hook ownership for ${contractAddress}`,
        ...(await populateInvokeTx(contract, 'transfer_ownership', [
          normalizeStarknetAddress(artifact.config.owner),
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
      (chainMetadata.rpcUrls ?? []).map((rpc: { http: string }) => rpc.http),
      chainMetadata.chainId,
      { metadata: chainMetadata },
    );
    this.mailboxAddress = context?.mailbox
      ? normalizeStarknetAddress(context.mailbox)
      : '';
  }

  async readHook(address: string): Promise<DeployedHookArtifact> {
    const type = await this.provider.getHookType({ hookAddress: address });
    const reader = this.createReader(type as HookType);
    return reader.read(address) as Promise<DeployedHookArtifact>;
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
      protocolFee: () => new StarknetProtocolFeeHookReader(this.chainMetadata),
      interchainGasPaymaster: () => {
        throw new Error('IGP hook is unsupported on Starknet');
      },
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
      merkleTreeHook: () =>
        new StarknetMerkleTreeHookWriter(starknetSigner, this.mailboxAddress),
      protocolFee: () =>
        new StarknetProtocolFeeHookWriter(this.chainMetadata, starknetSigner),
      interchainGasPaymaster: () => {
        throw new Error('IGP hook is unsupported on Starknet');
      },
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
