import { TrustedRelayerIsm__factory } from '@hyperlane-xyz/core';
import { AltVM } from '@hyperlane-xyz/provider-sdk';
import {
  ArtifactDeployed,
  ArtifactNew,
  ArtifactReader,
  ArtifactState,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedIsmAddress,
  DeployedRawIsmArtifact,
  IRawIsmArtifactManager,
  IsmType,
  MultisigIsmConfig,
  RawIsmArtifactConfigs,
  TestIsmConfig,
} from '@hyperlane-xyz/provider-sdk/ism';
import { TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import { strip0x } from '@hyperlane-xyz/utils';

import { TronProvider } from '../clients/provider.js';
import { TronSigner } from '../clients/signer.js';
import { TronSDKReceipt, TronSDKTransaction } from '../utils/types.js';

type AnnotatedTronTransaction = TronSDKTransaction;

/**
 * Factory addresses for ISM deployment on Tron.
 * These are deployed as part of core deployment.
 */
export interface TronIsmFactories {
  staticMessageIdMultisigIsmFactory?: string;
  staticMerkleRootMultisigIsmFactory?: string;
}

/**
 * Maps AltVM IsmType enum values to provider-sdk IsmType string literals.
 */
function altVmIsmTypeToProviderSdkType(altVmType: AltVM.IsmType): IsmType {
  switch (altVmType) {
    case AltVM.IsmType.TEST_ISM:
      return 'testIsm';
    case AltVM.IsmType.MERKLE_ROOT_MULTISIG:
      return 'merkleRootMultisigIsm';
    case AltVM.IsmType.MESSAGE_ID_MULTISIG:
      return 'messageIdMultisigIsm';
    case AltVM.IsmType.ROUTING:
      return 'domainRoutingIsm';
    default:
      throw new Error(`Unsupported ISM type: ${altVmType}`);
  }
}

/**
 * TronIsmArtifactManager implements ISM deployment for Tron.
 * Since Tron is EVM-compatible, we use the same Solidity contract bytecode.
 *
 * For multisig ISMs, factory addresses must be provided. These factories
 * are deployed as part of core deployment.
 */
export class TronIsmArtifactManager implements IRawIsmArtifactManager {
  constructor(
    private readonly provider: TronProvider,
    private readonly factories?: TronIsmFactories,
  ) {}

  async readIsm(address: string): Promise<DeployedRawIsmArtifact> {
    const altVmIsmType = await this.provider.getIsmType({
      ismAddress: address,
    });
    const ismType = altVmIsmTypeToProviderSdkType(altVmIsmType);
    const reader = this.createReader(ismType);
    return reader.read(address);
  }

  createReader<T extends IsmType>(
    type: T,
  ): ArtifactReader<RawIsmArtifactConfigs[T], DeployedIsmAddress> {
    switch (type) {
      case AltVM.IsmType.TEST_ISM:
        return new TronTestIsmReader(
          this.provider,
        ) as unknown as ArtifactReader<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddress
        >;
      case AltVM.IsmType.MESSAGE_ID_MULTISIG:
        return new TronMultisigIsmReader(
          this.provider,
          AltVM.IsmType.MESSAGE_ID_MULTISIG,
        ) as unknown as ArtifactReader<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddress
        >;
      case AltVM.IsmType.MERKLE_ROOT_MULTISIG:
        return new TronMultisigIsmReader(
          this.provider,
          AltVM.IsmType.MERKLE_ROOT_MULTISIG,
        ) as unknown as ArtifactReader<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddress
        >;
      default:
        throw new Error(`ISM type ${type} reader not yet implemented for Tron`);
    }
  }

  createWriter<T extends IsmType>(
    type: T,
    signer: TronSigner,
  ): ArtifactWriter<RawIsmArtifactConfigs[T], DeployedIsmAddress> {
    switch (type) {
      case AltVM.IsmType.TEST_ISM:
        return new TronTestIsmWriter(
          this.provider,
          signer,
        ) as unknown as ArtifactWriter<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddress
        >;
      case AltVM.IsmType.MESSAGE_ID_MULTISIG:
        if (!this.factories?.staticMessageIdMultisigIsmFactory) {
          throw new Error(
            'staticMessageIdMultisigIsmFactory address required for MESSAGE_ID_MULTISIG',
          );
        }
        return new TronMultisigIsmWriter(
          this.provider,
          signer,
          this.factories.staticMessageIdMultisigIsmFactory,
          AltVM.IsmType.MESSAGE_ID_MULTISIG,
        ) as unknown as ArtifactWriter<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddress
        >;
      case AltVM.IsmType.MERKLE_ROOT_MULTISIG:
        if (!this.factories?.staticMerkleRootMultisigIsmFactory) {
          throw new Error(
            'staticMerkleRootMultisigIsmFactory address required for MERKLE_ROOT_MULTISIG',
          );
        }
        return new TronMultisigIsmWriter(
          this.provider,
          signer,
          this.factories.staticMerkleRootMultisigIsmFactory,
          AltVM.IsmType.MERKLE_ROOT_MULTISIG,
        ) as unknown as ArtifactWriter<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddress
        >;
      default:
        throw new Error(`ISM type ${type} writer not yet implemented for Tron`);
    }
  }
}

// ============ Test ISM (TrustedRelayerIsm) ============

export class TronTestIsmReader
  implements ArtifactReader<TestIsmConfig, DeployedIsmAddress>
{
  constructor(protected readonly provider: TronProvider) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<TestIsmConfig, DeployedIsmAddress>> {
    return {
      artifactState: ArtifactState.DEPLOYED,
      config: { type: AltVM.IsmType.TEST_ISM },
      deployed: { address },
    };
  }
}

export class TronTestIsmWriter
  extends TronTestIsmReader
  implements ArtifactWriter<TestIsmConfig, DeployedIsmAddress>
{
  constructor(
    provider: TronProvider,
    private readonly signer: TronSigner,
  ) {
    super(provider);
  }

  async create(
    artifact: ArtifactNew<TestIsmConfig>,
  ): Promise<
    [ArtifactDeployed<TestIsmConfig, DeployedIsmAddress>, TxReceipt[]]
  > {
    // Deploy TrustedRelayerIsm with the signer as the trusted relayer
    const { abi, bytecode } = TrustedRelayerIsm__factory;
    const signerAddress = this.signer.getSignerAddress();

    // TrustedRelayerIsm constructor takes (address _mailbox)
    // For testing, we use a placeholder - actual deployment should use real mailbox
    const result = await this.signer.deployContractWithArtifacts({
      abi: abi as never,
      bytecode: strip0x(bytecode),
      constructorParams: [signerAddress], // Use signer as placeholder mailbox
      name: 'TrustedRelayerIsm',
    });

    const deployedArtifact: ArtifactDeployed<
      TestIsmConfig,
      DeployedIsmAddress
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config: artifact.config,
      deployed: { address: result.address },
    };

    // Create a TxReceipt from TronSDKReceipt
    const receipt: TronSDKReceipt = {
      txId: result.txId,
      blockNumber: 0, // Will be filled after confirmation
      success: true,
      contractAddress: result.address,
    };

    return [deployedArtifact, [receipt as unknown as TxReceipt]];
  }

  async update(
    _artifact: ArtifactDeployed<TestIsmConfig, DeployedIsmAddress>,
  ): Promise<AnnotatedTronTransaction[]> {
    // Test ISM has no mutable state
    return [];
  }
}

// ============ Multisig ISM ============

export class TronMultisigIsmReader
  implements ArtifactReader<MultisigIsmConfig, DeployedIsmAddress>
{
  constructor(
    protected readonly provider: TronProvider,
    protected readonly ismType:
      | typeof AltVM.IsmType.MESSAGE_ID_MULTISIG
      | typeof AltVM.IsmType.MERKLE_ROOT_MULTISIG,
  ) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<MultisigIsmConfig, DeployedIsmAddress>> {
    // Read validators and threshold from the ISM contract
    const ismData =
      this.ismType === AltVM.IsmType.MESSAGE_ID_MULTISIG
        ? await this.provider.getMessageIdMultisigIsm({ ismAddress: address })
        : await this.provider.getMerkleRootMultisigIsm({ ismAddress: address });

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: this.ismType,
        validators: ismData.validators,
        threshold: ismData.threshold,
      },
      deployed: { address },
    };
  }
}

export class TronMultisigIsmWriter
  extends TronMultisigIsmReader
  implements ArtifactWriter<MultisigIsmConfig, DeployedIsmAddress>
{
  constructor(
    provider: TronProvider,
    private readonly signer: TronSigner,
    private readonly factoryAddress: string,
    ismType:
      | typeof AltVM.IsmType.MESSAGE_ID_MULTISIG
      | typeof AltVM.IsmType.MERKLE_ROOT_MULTISIG,
  ) {
    super(provider, ismType);
  }

  async create(
    artifact: ArtifactNew<MultisigIsmConfig>,
  ): Promise<
    [ArtifactDeployed<MultisigIsmConfig, DeployedIsmAddress>, TxReceipt[]]
  > {
    const { validators, threshold } = artifact.config;

    // Sort validators for deterministic address generation
    const sortedValidators = [...validators].sort();

    // Call factory.deploy(validators, threshold) to create new ISM
    // The factory uses CREATE2 for deterministic addresses
    const receipt = await this.signer.callContract(
      this.factoryAddress,
      'deploy(address[],uint8)',
      [
        { type: 'address[]', value: sortedValidators },
        { type: 'uint8', value: threshold },
      ],
    );

    // Get the deployed ISM address from the factory
    // The address is deterministic based on validators and threshold
    const ismAddress = await this.getDeployedAddress(
      sortedValidators,
      threshold,
    );

    const deployedArtifact: ArtifactDeployed<
      MultisigIsmConfig,
      DeployedIsmAddress
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config: artifact.config,
      deployed: { address: ismAddress },
    };

    return [deployedArtifact, [receipt as unknown as TxReceipt]];
  }

  /**
   * Get the deterministic address for an ISM with given validators and threshold.
   * Uses the factory's getAddress function.
   */
  private async getDeployedAddress(
    validators: string[],
    threshold: number,
  ): Promise<string> {
    const result = await this.provider.callContractView(
      this.factoryAddress,
      'getAddress(address[],uint8)',
      [
        { type: 'address[]', value: validators },
        { type: 'uint8', value: threshold },
      ],
    );
    return result as string;
  }

  async update(
    _artifact: ArtifactDeployed<MultisigIsmConfig, DeployedIsmAddress>,
  ): Promise<AnnotatedTronTransaction[]> {
    // Static multisig ISMs are immutable
    return [];
  }
}
