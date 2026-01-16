import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

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
  IgpHookConfig,
} from '@hyperlane-xyz/provider-sdk/hook';
import { TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import { eqAddressRadix } from '@hyperlane-xyz/utils';

import { RadixBase } from '../utils/base.js';
import { RadixBaseSigner } from '../utils/signer.js';
import { AnnotatedRadixTransaction } from '../utils/types.js';

import { getIgpHookConfig } from './hook-query.js';
import {
  getCreateIgpTx,
  getSetIgpDestinationGasConfigTx,
  getSetIgpOwnerTx,
} from './hook-tx.js';

export class RadixIgpHookReader
  implements ArtifactReader<IgpHookConfig, DeployedHookAddress>
{
  constructor(protected readonly gateway: Readonly<GatewayApiClient>) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<IgpHookConfig, DeployedHookAddress>> {
    const hookConfig = await getIgpHookConfig(this.gateway, address);

    // Map Radix IGP config to provider-sdk IgpHookConfig format
    // Note: Using numeric domain IDs as keys (Artifact API), not chain names
    const overhead: Record<number, number> = {};
    const oracleConfig: Record<
      number,
      {
        gasPrice: string;
        tokenExchangeRate: string;
        tokenDecimals?: number;
      }
    > = {};

    for (const [domainIdStr, gasConfig] of Object.entries(
      hookConfig.destinationGasConfigs,
    )) {
      const domainId = parseInt(domainIdStr);
      overhead[domainId] = parseInt(gasConfig.gasOverhead);
      oracleConfig[domainId] = {
        gasPrice: gasConfig.gasOracle.gasPrice,
        tokenExchangeRate: gasConfig.gasOracle.tokenExchangeRate,
        // Radix IGP doesn't store tokenDecimals on-chain.
        // The exchange rate is pre-calculated to include decimal adjustments.
        // tokenDecimals is left undefined (optional field).
      };
    }

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
        owner: hookConfig.owner,
        // Radix IGP doesn't have beneficiary and oracleKey in the same way as EVM
        // Setting them to owner as a placeholder
        beneficiary: hookConfig.owner,
        oracleKey: hookConfig.owner,
        overhead,
        oracleConfig,
      },
      deployed: {
        address: hookConfig.address,
      },
    };
  }
}

export class RadixIgpHookWriter
  extends RadixIgpHookReader
  implements ArtifactWriter<IgpHookConfig, DeployedHookAddress>
{
  constructor(
    gateway: Readonly<GatewayApiClient>,
    private readonly signer: RadixBaseSigner,
    private readonly base: RadixBase,
    private readonly nativeTokenDenom: string,
  ) {
    super(gateway);
  }

  async create(
    artifact: ArtifactNew<IgpHookConfig>,
  ): Promise<
    [ArtifactDeployed<IgpHookConfig, DeployedHookAddress>, TxReceipt[]]
  > {
    const { config } = artifact;
    const allReceipts: TxReceipt[] = [];

    // Create the IGP
    const transactionManifest = await getCreateIgpTx(
      this.base,
      this.signer.getAddress(),
      this.nativeTokenDenom,
    );

    const createReceipt =
      await this.signer.signAndBroadcast(transactionManifest);
    const address = await this.base.getNewComponent(createReceipt);
    allReceipts.push(createReceipt);

    // Set destination gas configs for each domain
    for (const [domainIdStr, gasConfig] of Object.entries(
      config.oracleConfig,
    )) {
      const domainId = parseInt(domainIdStr);
      const setConfigTx = await getSetIgpDestinationGasConfigTx(
        this.base,
        this.signer.getAddress(),
        {
          igpAddress: address,
          destinationGasConfig: {
            remoteDomainId: domainId,
            gasOracle: {
              tokenExchangeRate: gasConfig.tokenExchangeRate,
              gasPrice: gasConfig.gasPrice,
            },
            gasOverhead: config.overhead[domainId]?.toString() || '0',
          },
        },
      );

      const configReceipt = await this.signer.signAndBroadcast(setConfigTx);
      allReceipts.push(configReceipt);
    }

    // Transfer ownership if the configured owner is different from the signer
    if (!eqAddressRadix(this.signer.getAddress(), config.owner)) {
      const setOwnerTx = await getSetIgpOwnerTx(
        this.base,
        this.gateway,
        this.signer.getAddress(),
        {
          igpAddress: address,
          newOwner: config.owner,
        },
      );
      const ownerReceipt = await this.signer.signAndBroadcast(setOwnerTx);
      allReceipts.push(ownerReceipt);
    }

    const deployedArtifact: ArtifactDeployed<
      IgpHookConfig,
      DeployedHookAddress
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config: artifact.config,
      deployed: {
        address,
      },
    };

    return [deployedArtifact, allReceipts];
  }

  async update(
    artifact: ArtifactDeployed<IgpHookConfig, DeployedHookAddress>,
  ): Promise<AnnotatedRadixTransaction[]> {
    const { config, deployed } = artifact;
    const updateTxs: AnnotatedRadixTransaction[] = [];

    // Read current state
    const currentState = await this.read(deployed.address);

    // Update destination gas configs
    for (const [domainIdStr, gasConfig] of Object.entries(
      config.oracleConfig,
    )) {
      const domainId = parseInt(domainIdStr);
      const currentGasConfig = currentState.config.oracleConfig[domainId];
      const needsUpdate =
        !currentGasConfig ||
        currentGasConfig.tokenExchangeRate !== gasConfig.tokenExchangeRate ||
        currentGasConfig.gasPrice !== gasConfig.gasPrice ||
        currentState.config.overhead[domainId] !== config.overhead[domainId];

      if (needsUpdate) {
        const setConfigTx = await getSetIgpDestinationGasConfigTx(
          this.base,
          this.signer.getAddress(),
          {
            igpAddress: deployed.address,
            destinationGasConfig: {
              remoteDomainId: domainId,
              gasOracle: {
                tokenExchangeRate: gasConfig.tokenExchangeRate,
                gasPrice: gasConfig.gasPrice,
              },
              gasOverhead: config.overhead[domainId]?.toString() || '0',
            },
          },
        );
        updateTxs.push({
          annotation: `Updating IGP gas config for domain ${domainId}`,
          networkId: this.base.getNetworkId(),
          manifest: setConfigTx,
        });
      }
    }

    // Owner transfer must be last transaction as the current owner executes all updates
    if (!eqAddressRadix(currentState.config.owner, config.owner)) {
      const setOwnerTx = await getSetIgpOwnerTx(
        this.base,
        this.gateway,
        this.signer.getAddress(),
        {
          igpAddress: deployed.address,
          newOwner: config.owner,
        },
      );
      updateTxs.push({
        annotation: 'Setting new IGP owner',
        networkId: this.base.getNetworkId(),
        manifest: setOwnerTx,
      });
    }

    return updateTxs;
  }
}
