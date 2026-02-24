import { type DeliverTxResponse } from '@cosmjs/stargate';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import {
  type ArtifactDeployed,
  type ArtifactNew,
  type ArtifactReader,
  ArtifactState,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedHookAddress,
  type IgpHookConfig,
} from '@hyperlane-xyz/provider-sdk/hook';
import { eqAddressCosmos } from '@hyperlane-xyz/utils';

import { type CosmosNativeSigner } from '../clients/signer.js';
import { getNewContractAddress } from '../utils/base.js';
import { type AnnotatedEncodeObject } from '../utils/types.js';

import { type CosmosHookQueryClient, getIgpHookConfig } from './hook-query.js';
import {
  getCreateIgpTx,
  getSetIgpDestinationGasConfigTx,
  getSetIgpOwnerTx,
} from './hook-tx.js';

/**
 * Reader for Cosmos IGP (Interchain Gas Paymaster) Hook.
 * Reads deployed IGP hook configuration from the chain.
 */
export class CosmosIgpHookReader implements ArtifactReader<
  IgpHookConfig,
  DeployedHookAddress
> {
  constructor(protected readonly query: CosmosHookQueryClient) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<IgpHookConfig, DeployedHookAddress>> {
    const hookConfig = await getIgpHookConfig(this.query, address);

    // Map Cosmos IGP config to provider-sdk IgpHookConfig format
    const overhead: Record<string, number> = {};
    const oracleConfig: Record<
      string,
      {
        gasPrice: string;
        tokenExchangeRate: string;
      }
    > = {};

    for (const [domainId, gasConfig] of Object.entries(
      hookConfig.destinationGasConfigs,
    )) {
      overhead[domainId] = parseInt(gasConfig.gasOverhead);
      oracleConfig[domainId] = {
        gasPrice: gasConfig.gasOracle.gasPrice,
        tokenExchangeRate: gasConfig.gasOracle.tokenExchangeRate,
      };
    }

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
        owner: hookConfig.owner,
        // Cosmos IGP doesn't have beneficiary and oracleKey in the same way as EVM
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

/**
 * Writer for Cosmos IGP (Interchain Gas Paymaster) Hook.
 * Handles deployment and updates of IGP hooks.
 */
export class CosmosIgpHookWriter
  extends CosmosIgpHookReader
  implements ArtifactWriter<IgpHookConfig, DeployedHookAddress>
{
  constructor(
    query: CosmosHookQueryClient,
    private readonly signer: CosmosNativeSigner,
    private readonly denom: string,
  ) {
    super(query);
  }

  async create(
    artifact: ArtifactNew<IgpHookConfig>,
  ): Promise<
    [ArtifactDeployed<IgpHookConfig, DeployedHookAddress>, DeliverTxResponse[]]
  > {
    const { config } = artifact;
    const receipts: DeliverTxResponse[] = [];

    // Create the IGP hook
    const createTx = getCreateIgpTx(this.signer.getSignerAddress(), this.denom);

    const createReceipt = await this.signer.sendAndConfirmTransaction(createTx);
    const address = getNewContractAddress(createReceipt);
    receipts.push(createReceipt);

    // Set destination gas configs for each domain
    for (const [domainId, gasConfig] of Object.entries(config.oracleConfig)) {
      const parsedDomainId = parseInt(domainId);

      const setConfigTx = getSetIgpDestinationGasConfigTx(
        this.signer.getSignerAddress(),
        {
          igpAddress: address,
          destinationGasConfig: {
            remoteDomainId: parsedDomainId,
            gasOracle: {
              tokenExchangeRate: gasConfig.tokenExchangeRate,
              gasPrice: gasConfig.gasPrice,
            },
            gasOverhead: config.overhead[parsedDomainId]?.toString() || '0',
          },
        },
      );

      const configReceipt =
        await this.signer.sendAndConfirmTransaction(setConfigTx);
      receipts.push(configReceipt);
    }

    // Transfer ownership if needed (deployer is initial owner)
    const deployerAddress = this.signer.getSignerAddress();
    if (!eqAddressCosmos(artifact.config.owner, deployerAddress)) {
      const ownerTx = getSetIgpOwnerTx(deployerAddress, {
        igpAddress: address,
        newOwner: artifact.config.owner,
      });

      const ownerReceipt = await this.signer.sendAndConfirmTransaction(ownerTx);
      receipts.push(ownerReceipt);
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

    return [deployedArtifact, receipts];
  }

  async update(
    artifact: ArtifactDeployed<IgpHookConfig, DeployedHookAddress>,
  ): Promise<AnnotatedEncodeObject[]> {
    const { config, deployed } = artifact;
    const updateTxs: AnnotatedEncodeObject[] = [];

    // Read current state
    const currentState = await this.read(deployed.address);

    // Update destination gas configs
    for (const [domainId, gasConfig] of Object.entries(config.oracleConfig)) {
      const parsedDomainId = parseInt(domainId);

      const currentGasConfig = currentState.config.oracleConfig[parsedDomainId];
      const needsUpdate =
        !currentGasConfig ||
        currentGasConfig.tokenExchangeRate !== gasConfig.tokenExchangeRate ||
        currentGasConfig.gasPrice !== gasConfig.gasPrice ||
        currentState.config.overhead[parsedDomainId] !==
          config.overhead[parsedDomainId];

      if (needsUpdate) {
        const setConfigTx = getSetIgpDestinationGasConfigTx(
          this.signer.getSignerAddress(),
          {
            igpAddress: deployed.address,
            destinationGasConfig: {
              remoteDomainId: parsedDomainId,
              gasOracle: {
                tokenExchangeRate: gasConfig.tokenExchangeRate,
                gasPrice: gasConfig.gasPrice,
              },
              gasOverhead: config.overhead[parsedDomainId]?.toString() || '0',
            },
          },
        );

        updateTxs.push({
          annotation: `Setting destination gas config for domain ${domainId}`,
          ...setConfigTx,
        });
      }
    }

    // Check if owner needs to be updated
    if (!eqAddressCosmos(currentState.config.owner, config.owner)) {
      const setOwnerTx = getSetIgpOwnerTx(this.signer.getSignerAddress(), {
        igpAddress: deployed.address,
        newOwner: config.owner,
      });

      updateTxs.push({
        annotation: `Setting IGP hook owner to ${artifact.config.owner}`,
        ...setOwnerTx,
      });
    }

    return updateTxs;
  }
}
