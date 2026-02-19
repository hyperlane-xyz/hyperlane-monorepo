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
import { eqAddressStarknet, assert } from '@hyperlane-xyz/utils';

import { StarknetProvider } from '../clients/provider.js';
import { StarknetSigner } from '../clients/signer.js';
import {
  StarknetContractName,
  callContract,
  getFeeTokenAddress,
  getStarknetContract,
  normalizeStarknetAddressSafe,
  populateInvokeTx,
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

class StarknetProtocolFeeAsIgpHookReader
  implements
    ArtifactReader<
      RawHookArtifactConfigs['interchainGasPaymaster'],
      DeployedHookAddress
    >
{
  constructor(protected readonly chainMetadata: ChainMetadataForAltVM) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<
      RawHookArtifactConfigs['interchainGasPaymaster'],
      DeployedHookAddress
    >
  > {
    const normalizedAddress = normalizeStarknetAddressSafe(address);
    const hook = getStarknetContract(
      StarknetContractName.PROTOCOL_FEE,
      normalizedAddress,
    );

    const [owner, beneficiary] = await Promise.all([
      callContract(hook, 'owner'),
      callContract(hook, 'get_beneficiary'),
    ]);

    const ownerAddress = normalizeStarknetAddressSafe(owner);
    const beneficiaryAddress = normalizeStarknetAddressSafe(beneficiary);

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
        owner: ownerAddress,
        beneficiary: beneficiaryAddress,
        oracleKey: ownerAddress,
        overhead: {},
        oracleConfig: {},
      },
      deployed: { address: normalizedAddress },
    };
  }
}

class StarknetProtocolFeeAsIgpHookWriter
  extends StarknetProtocolFeeAsIgpHookReader
  implements
    ArtifactWriter<
      RawHookArtifactConfigs['interchainGasPaymaster'],
      DeployedHookAddress
    >
{
  constructor(
    chainMetadata: ChainMetadataForAltVM,
    private readonly signer: StarknetSigner,
  ) {
    super(chainMetadata);
  }

  private assertSupportedIgpShape(
    config: RawHookArtifactConfigs['interchainGasPaymaster'],
  ) {
    assert(
      Object.keys(config.overhead).length === 0,
      'Starknet protocol_fee hook does not support overhead gas config updates',
    );
    assert(
      Object.keys(config.oracleConfig).length === 0,
      'Starknet protocol_fee hook does not support oracle gas config updates',
    );
    assert(
      eqAddressStarknet(config.oracleKey, config.owner),
      'Starknet protocol_fee mapping requires oracleKey to equal owner',
    );
  }

  async create(
    artifact: ArtifactNew<RawHookArtifactConfigs['interchainGasPaymaster']>,
  ): Promise<
    [
      ArtifactDeployed<
        RawHookArtifactConfigs['interchainGasPaymaster'],
        DeployedHookAddress
      >,
      TxReceipt[],
    ]
  > {
    this.assertSupportedIgpShape(artifact.config);

    const tokenAddress = getFeeTokenAddress({
      chainName: this.chainMetadata.name,
      nativeDenom: this.chainMetadata.nativeToken?.denom,
    });

    const deployTx = {
      kind: 'deploy',
      contractName: StarknetContractName.PROTOCOL_FEE,
      constructorArgs: [
        0,
        0,
        normalizeStarknetAddressSafe(artifact.config.beneficiary),
        normalizeStarknetAddressSafe(artifact.config.owner),
        tokenAddress,
      ],
    } satisfies StarknetDeployTx;

    const receipt = await this.signer.sendAndConfirmTransaction(deployTx);
    assert(receipt.contractAddress, 'failed to deploy Starknet protocol_fee hook');

    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        config: artifact.config,
        deployed: { address: normalizeStarknetAddressSafe(receipt.contractAddress) },
      },
      [receipt],
    ];
  }

  async update(
    artifact: ArtifactDeployed<
      RawHookArtifactConfigs['interchainGasPaymaster'],
      DeployedHookAddress
    >,
  ): Promise<AnnotatedTx[]> {
    this.assertSupportedIgpShape(artifact.config);

    const current = await this.read(artifact.deployed.address);
    const contractAddress = artifact.deployed.address;
    const contract = getStarknetContract(
      StarknetContractName.PROTOCOL_FEE,
      contractAddress,
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

    if (
      hookType === AltVM.HookType.PROTOCOL_FEE ||
      hookType === AltVM.HookType.INTERCHAIN_GAS_PAYMASTER
    ) {
      return this.createReader(AltVM.HookType.INTERCHAIN_GAS_PAYMASTER).read(
        address,
      );
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
      interchainGasPaymaster: () =>
        new StarknetProtocolFeeAsIgpHookReader(this.chainMetadata),
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
      interchainGasPaymaster: () =>
        new StarknetProtocolFeeAsIgpHookWriter(
          this.chainMetadata,
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
