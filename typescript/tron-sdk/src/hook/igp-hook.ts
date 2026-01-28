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
  getCreateOracleTx,
  getCreateProxyTx,
  getInitIgpTx,
  getSetIgpDestinationGasConfigTx,
  getSetIgpOwnerTx,
  getSetOracleTx,
  getSetRemoteGasTx,
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
    private readonly proxyAdminAddress: string,
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

    const deployerAddress = this.signer.getSignerAddress();

    // Create the IGP hook
    const createTx = await getCreateIgpTx(
      this.signer.getTronweb(),
      deployerAddress,
    );

    const createReceipt = await this.signer.sendAndConfirmTransaction(createTx);
    const implAddress = this.signer
      .getTronweb()
      .address.fromHex(createReceipt.contract_address);
    receipts.push(createReceipt);

    const createProxyTx = await getCreateProxyTx(
      this.signer.getTronweb(),
      deployerAddress,
      implAddress,
      this.proxyAdminAddress,
    );
    const createProxyReceipt =
      await this.signer.sendAndConfirmTransaction(createProxyTx);
    const igpAddress = this.signer
      .getTronweb()
      .address.fromHex(createProxyReceipt.contract_address);
    receipts.push(createProxyReceipt);

    const initTx = await getInitIgpTx(
      this.signer.getTronweb(),
      deployerAddress,
      {
        igpAddress,
      },
    );
    const initReceipt = await this.signer.sendAndConfirmTransaction(initTx);
    receipts.push(initReceipt);

    // Create the Storage Gas Oracle
    const createOracleTx = await getCreateOracleTx(
      this.signer.getTronweb(),
      deployerAddress,
    );

    const createOracleReceipt =
      await this.signer.sendAndConfirmTransaction(createOracleTx);
    const oracleAddress = this.signer
      .getTronweb()
      .address.fromHex(createOracleReceipt.contract_address);
    receipts.push(createOracleReceipt);

    const setOracleTx = await getSetOracleTx(
      this.signer.getTronweb(),
      deployerAddress,
      {
        igpAddress,
        oracleAddress,
      },
    );
    const setOracleReceipt =
      await this.signer.sendAndConfirmTransaction(setOracleTx);
    receipts.push(setOracleReceipt);

    const setGasTx = await getSetRemoteGasTx(
      this.signer.getTronweb(),
      deployerAddress,
      {
        igpAddress,
        destinationGasConfigs: Object.keys(config.oracleConfig).map(
          (domainId) => ({
            remoteDomainId: parseInt(domainId),
            gasOracle: {
              tokenExchangeRate:
                config.oracleConfig[+domainId].tokenExchangeRate,
              gasPrice: config.oracleConfig[+domainId].gasPrice,
            },
          }),
        ),
      },
    );

    const gasReceipt = await this.signer.sendAndConfirmTransaction(setGasTx);
    receipts.push(gasReceipt);

    const setConfigTx = await getSetIgpDestinationGasConfigTx(
      this.signer.getTronweb(),
      deployerAddress,
      {
        igpAddress,
        destinationGasConfigs: Object.keys(config.overhead).map((domainId) => ({
          remoteDomainId: parseInt(domainId),
          gasOverhead: config.overhead[+domainId]?.toString() ?? '0',
        })),
      },
    );

    const configReceipt =
      await this.signer.sendAndConfirmTransaction(setConfigTx);
    receipts.push(configReceipt);

    // Transfer ownership if needed (deployer is initial owner)
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
        const setGasTx = await getSetRemoteGasTx(
          this.signer.getTronweb(),
          this.signer.getSignerAddress(),
          {
            igpAddress: deployed.address,
            destinationGasConfigs: [
              {
                remoteDomainId: parsedDomainId,
                gasOracle: {
                  tokenExchangeRate: gasConfig.tokenExchangeRate,
                  gasPrice: gasConfig.gasPrice,
                },
              },
            ],
          },
        );

        const gasReceipt =
          await this.signer.sendAndConfirmTransaction(setGasTx);
        updateTxs.push({
          annotation: `Setting remote gas config for domain ${domainId}`,
          ...gasReceipt,
        });

        const setConfigTx = await getSetIgpDestinationGasConfigTx(
          this.signer.getTronweb(),
          this.signer.getSignerAddress(),
          {
            igpAddress: deployed.address,
            destinationGasConfigs: [
              {
                remoteDomainId: parsedDomainId,
                gasOverhead: config.overhead[parsedDomainId]?.toString() || '0',
              },
            ],
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
