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
 */
export class TronIsmArtifactManager implements IRawIsmArtifactManager {
  constructor(private readonly provider: TronProvider) {}

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
