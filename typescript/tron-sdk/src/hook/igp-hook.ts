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
import { AnnotatedTx } from '@hyperlane-xyz/provider-sdk/module';
import { eqAddressTron } from '@hyperlane-xyz/utils';

import { type TronSigner } from '../clients/signer.js';
import { TronReceipt } from '../utils/types.js';

import { type TronHookQueryClient, getIgpHookConfig } from './hook-query.js';
import {
  getCreateIgpTx,
  getSetIgpDestinationGasConfigTx,
  getSetIgpOwnerTx,
} from './hook-tx.js';

/**
 * Reader for Tron IGP (Interchain Gas Paymaster) Hook.
 * Reads deployed IGP hook configuration from the chain.
 */
export class TronIgpHookReader
  implements ArtifactReader<IgpHookConfig, DeployedHookAddress>
{
  constructor(protected readonly query: TronHookQueryClient) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<IgpHookConfig, DeployedHookAddress>> {
    const hookConfig = await getIgpHookConfig(this.query, address);

    // Map Tron IGP config to provider-sdk IgpHookConfig format
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
        // Tron IGP doesn't have beneficiary and oracleKey in the same way as EVM
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
 * Writer for Tron IGP (Interchain Gas Paymaster) Hook.
 * Handles deployment and updates of IGP hooks.
 */
export class TronIgpHookWriter
  extends TronIgpHookReader
  implements ArtifactWriter<IgpHookConfig, DeployedHookAddress>
{
  constructor(
    query: TronHookQueryClient,
    private readonly signer: TronSigner,
  ) {
    super(query);
  }

  async create(
    artifact: ArtifactNew<IgpHookConfig>,
  ): Promise<
    [ArtifactDeployed<IgpHookConfig, DeployedHookAddress>, TronReceipt[]]
  > {
    const { config } = artifact;
    const receipts: TronReceipt[] = [];

    // Create the IGP hook
    const createTx = await getCreateIgpTx(
      this.signer.getTronweb(),
      this.signer.getSignerAddress(),
    );

    const createReceipt = await this.signer.sendAndConfirmTransaction(createTx);
    const igpAddress = this.signer
      .getTronweb()
      .address.fromHex(createReceipt.contract_address);
    receipts.push(createReceipt);

    // Set destination gas configs for each domain
    for (const [domainId, gasConfig] of Object.entries(config.oracleConfig)) {
      const parsedDomainId = parseInt(domainId);

      const setConfigTx = await getSetIgpDestinationGasConfigTx(
        this.signer.getTronweb(),
        this.signer.getSignerAddress(),
        {
          igpAddress,
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
    if (!eqAddressTron(artifact.config.owner, deployerAddress)) {
      const ownerTx = await getSetIgpOwnerTx(
        this.signer.getTronweb(),
        deployerAddress,
        {
          igpAddress,
          newOwner: artifact.config.owner,
        },
      );

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
        address: igpAddress,
      },
    };

    return [deployedArtifact, receipts];
  }

  async update(
    artifact: ArtifactDeployed<IgpHookConfig, DeployedHookAddress>,
  ): Promise<AnnotatedTx[]> {
    const { config, deployed } = artifact;
    const updateTxs: AnnotatedTx[] = [];

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
        const setConfigTx = await getSetIgpDestinationGasConfigTx(
          this.signer.getTronweb(),
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
    if (!eqAddressTron(currentState.config.owner, config.owner)) {
      const setOwnerTx = await getSetIgpOwnerTx(
        this.signer.getTronweb(),
        this.signer.getSignerAddress(),
        {
          igpAddress: deployed.address,
          newOwner: config.owner,
        },
      );

      updateTxs.push({
        annotation: `Setting IGP hook owner to ${artifact.config.owner}`,
        ...setOwnerTx,
      });
    }

    return updateTxs;
  }
}
