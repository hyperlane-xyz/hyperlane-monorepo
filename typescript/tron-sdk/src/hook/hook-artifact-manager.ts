import {
  InterchainGasPaymaster__factory,
  MerkleTreeHook__factory,
} from '@hyperlane-xyz/core';
import { AltVM } from '@hyperlane-xyz/provider-sdk';
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
  IgpHookConfig,
  MerkleTreeHookConfig,
  RawHookArtifactConfigs,
} from '@hyperlane-xyz/provider-sdk/hook';
import { TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import { strip0x } from '@hyperlane-xyz/utils';

import { TronProvider } from '../clients/provider.js';
import { TronSigner } from '../clients/signer.js';
import { TronSDKReceipt, TronSDKTransaction } from '../utils/types.js';

type AnnotatedTronTransaction = TronSDKTransaction;

/**
 * Maps AltVM HookType enum values to provider-sdk HookType string literals.
 */
function altVmHookTypeToProviderSdkType(altVmType: AltVM.HookType): HookType {
  switch (altVmType) {
    case AltVM.HookType.MERKLE_TREE:
      return 'merkleTreeHook';
    case AltVM.HookType.INTERCHAIN_GAS_PAYMASTER:
      return 'interchainGasPaymaster';
    default:
      throw new Error(`Unsupported Hook type: ${altVmType}`);
  }
}

/**
 * TronHookArtifactManager implements Hook deployment for Tron.
 * Since Tron is EVM-compatible, we use the same Solidity contract bytecode.
 */
export class TronHookArtifactManager implements IRawHookArtifactManager {
  constructor(
    private readonly provider: TronProvider,
    private readonly mailboxAddress: string,
  ) {}

  async readHook(address: string): Promise<DeployedHookArtifact> {
    const altVmHookType = await this.provider.getHookType({
      hookAddress: address,
    });
    const hookType = altVmHookTypeToProviderSdkType(altVmHookType);
    const reader = this.createReader(hookType);
    return reader.read(address);
  }

  createReader<T extends HookType>(
    type: T,
  ): ArtifactReader<RawHookArtifactConfigs[T], DeployedHookAddress> {
    switch (type) {
      case AltVM.HookType.MERKLE_TREE:
        return new TronMerkleTreeHookReader(
          this.provider,
        ) as unknown as ArtifactReader<
          RawHookArtifactConfigs[T],
          DeployedHookAddress
        >;
      case AltVM.HookType.INTERCHAIN_GAS_PAYMASTER:
        return new TronIgpHookReader(
          this.provider,
        ) as unknown as ArtifactReader<
          RawHookArtifactConfigs[T],
          DeployedHookAddress
        >;
      default:
        throw new Error(
          `Hook type ${type} reader not yet implemented for Tron`,
        );
    }
  }

  createWriter<T extends HookType>(
    type: T,
    signer: TronSigner,
  ): ArtifactWriter<RawHookArtifactConfigs[T], DeployedHookAddress> {
    switch (type) {
      case AltVM.HookType.MERKLE_TREE:
        return new TronMerkleTreeHookWriter(
          this.provider,
          signer,
          this.mailboxAddress,
        ) as unknown as ArtifactWriter<
          RawHookArtifactConfigs[T],
          DeployedHookAddress
        >;
      case AltVM.HookType.INTERCHAIN_GAS_PAYMASTER:
        return new TronIgpHookWriter(
          this.provider,
          signer,
        ) as unknown as ArtifactWriter<
          RawHookArtifactConfigs[T],
          DeployedHookAddress
        >;
      default:
        throw new Error(
          `Hook type ${type} writer not yet implemented for Tron`,
        );
    }
  }
}

// ============ Merkle Tree Hook ============

export class TronMerkleTreeHookReader
  implements ArtifactReader<MerkleTreeHookConfig, DeployedHookAddress>
{
  constructor(protected readonly provider: TronProvider) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<MerkleTreeHookConfig, DeployedHookAddress>> {
    return {
      artifactState: ArtifactState.DEPLOYED,
      config: { type: AltVM.HookType.MERKLE_TREE },
      deployed: { address },
    };
  }
}

export class TronMerkleTreeHookWriter
  extends TronMerkleTreeHookReader
  implements ArtifactWriter<MerkleTreeHookConfig, DeployedHookAddress>
{
  constructor(
    provider: TronProvider,
    private readonly signer: TronSigner,
    private readonly mailboxAddress: string,
  ) {
    super(provider);
  }

  async create(
    artifact: ArtifactNew<MerkleTreeHookConfig>,
  ): Promise<
    [ArtifactDeployed<MerkleTreeHookConfig, DeployedHookAddress>, TxReceipt[]]
  > {
    const { abi, bytecode } = MerkleTreeHook__factory;

    // MerkleTreeHook constructor takes (address _mailbox)
    const result = await this.signer.deployContractWithArtifacts({
      abi: abi as never,
      bytecode: strip0x(bytecode),
      constructorParams: [this.mailboxAddress],
      name: 'MerkleTreeHook',
    });

    const deployedArtifact: ArtifactDeployed<
      MerkleTreeHookConfig,
      DeployedHookAddress
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config: artifact.config,
      deployed: { address: result.address },
    };

    const receipt: TronSDKReceipt = {
      txId: result.txId,
      blockNumber: 0,
      success: true,
      contractAddress: result.address,
    };

    return [deployedArtifact, [receipt as unknown as TxReceipt]];
  }

  async update(
    _artifact: ArtifactDeployed<MerkleTreeHookConfig, DeployedHookAddress>,
  ): Promise<AnnotatedTronTransaction[]> {
    // MerkleTreeHook has no mutable state
    return [];
  }
}

// ============ Interchain Gas Paymaster Hook ============

export class TronIgpHookReader
  implements ArtifactReader<IgpHookConfig, DeployedHookAddress>
{
  constructor(protected readonly provider: TronProvider) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<IgpHookConfig, DeployedHookAddress>> {
    // Read IGP config from chain
    const igpData = await this.provider.getInterchainGasPaymasterHook({
      hookAddress: address,
    });

    // Convert destinationGasConfigs to overhead and oracleConfig format
    const overhead: Record<number, number> = {};
    const oracleConfig: Record<
      number,
      { gasPrice: string; tokenExchangeRate: string }
    > = {};

    for (const [domainIdStr, config] of Object.entries(
      igpData.destinationGasConfigs,
    )) {
      const domainId = parseInt(domainIdStr);
      overhead[domainId] = parseInt(config.gasOverhead);
      oracleConfig[domainId] = {
        gasPrice: config.gasOracle.gasPrice,
        tokenExchangeRate: config.gasOracle.tokenExchangeRate,
      };
    }

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
        owner: igpData.owner,
        beneficiary: igpData.owner, // Default to owner
        oracleKey: igpData.owner, // Default to owner
        overhead,
        oracleConfig,
      },
      deployed: { address },
    };
  }
}

export class TronIgpHookWriter
  extends TronIgpHookReader
  implements ArtifactWriter<IgpHookConfig, DeployedHookAddress>
{
  constructor(
    provider: TronProvider,
    private readonly signer: TronSigner,
  ) {
    super(provider);
  }

  async create(
    artifact: ArtifactNew<IgpHookConfig>,
  ): Promise<
    [ArtifactDeployed<IgpHookConfig, DeployedHookAddress>, TxReceipt[]]
  > {
    const { abi, bytecode } = InterchainGasPaymaster__factory;

    // InterchainGasPaymaster constructor takes no arguments
    // It uses OpenZeppelin's Ownable which sets msg.sender as owner
    const result = await this.signer.deployContractWithArtifacts({
      abi: abi as never,
      bytecode: strip0x(bytecode),
      constructorParams: [],
      name: 'InterchainGasPaymaster',
    });

    const deployedArtifact: ArtifactDeployed<
      IgpHookConfig,
      DeployedHookAddress
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config: artifact.config,
      deployed: { address: result.address },
    };

    const receipt: TronSDKReceipt = {
      txId: result.txId,
      blockNumber: 0,
      success: true,
      contractAddress: result.address,
    };

    return [deployedArtifact, [receipt as unknown as TxReceipt]];
  }

  async update(
    _artifact: ArtifactDeployed<IgpHookConfig, DeployedHookAddress>,
  ): Promise<AnnotatedTronTransaction[]> {
    // TODO: Implement IGP configuration updates (gas configs, owner transfer, etc.)
    return [];
  }
}
