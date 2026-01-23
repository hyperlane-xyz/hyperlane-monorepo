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
import { eqAddress, isNullish } from '@hyperlane-xyz/utils';

/**
 * Reader for  IGP (Interchain Gas Paymaster) Hook.
 * Reads deployed IGP hook configuration from the chain.
 */
export class IgpHookReader
  implements ArtifactReader<IgpHookConfig, DeployedHookAddress>
{
  constructor(protected readonly provider: AltVM.IProvider) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<IgpHookConfig, DeployedHookAddress>> {
    const hookConfig = await this.provider.getInterchainGasPaymasterHook({
      hookAddress: address,
    });

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
 * Writer for  IGP (Interchain Gas Paymaster) Hook.
 * Handles deployment and updates of IGP hooks.
 */
export class IgpHookWriter
  extends IgpHookReader
  implements ArtifactWriter<IgpHookConfig, DeployedHookAddress>
{
  constructor(
    query: AltVM.IProvider,
    private readonly signer: AltVM.ISigner<any, any>,
    private readonly mailboxAddress: string,
    private readonly denom: string,
  ) {
    super(query);
  }

  async create(
    artifact: ArtifactNew<IgpHookConfig>,
  ): Promise<[ArtifactDeployed<IgpHookConfig, DeployedHookAddress>, any[]]> {
    const { config } = artifact;
    const receipts: any[] = [];

    const { hookAddress, receipts: createReceipts } =
      await this.signer.createInterchainGasPaymasterHook({
        mailboxAddress: this.mailboxAddress,
        denom: this.denom,
      });
    receipts.push(...createReceipts);

    // Set destination gas configs for each domain
    for (const [domainId, gasConfig] of Object.entries(config.oracleConfig)) {
      const parsedDomainId = parseInt(domainId);

      const { receipts: setConfigReceipts } =
        await this.signer.setDestinationGasConfig({
          hookAddress,
          destinationGasConfig: {
            remoteDomainId: parsedDomainId,
            gasOracle: {
              tokenExchangeRate: gasConfig.tokenExchangeRate,
              gasPrice: gasConfig.gasPrice,
            },
            gasOverhead: config.overhead[parsedDomainId]?.toString() || '0',
          },
        });

      receipts.push(...setConfigReceipts);
    }

    // Transfer ownership if needed (deployer is initial owner)
    const deployerAddress = this.signer.getSignerAddress();
    if (!eqAddress(artifact.config.owner, deployerAddress)) {
      const { receipts: setOwnerReceipts } =
        await this.signer.setInterchainGasPaymasterHookOwner({
          hookAddress,
          newOwner: artifact.config.owner,
        });

      receipts.push(...setOwnerReceipts);
    }

    const deployedArtifact: ArtifactDeployed<
      IgpHookConfig,
      DeployedHookAddress
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config: artifact.config,
      deployed: {
        address: hookAddress,
      },
    };

    return [deployedArtifact, receipts];
  }

  async update(
    artifact: ArtifactDeployed<IgpHookConfig, DeployedHookAddress>,
  ): Promise<any[]> {
    const current = await this.read(artifact.deployed.address);
    const transactions: any[] = [];

    // Handle destination gas config updates first
    const currentOverhead = current.config.overhead;
    const desiredOverhead = artifact.config.overhead;
    const currentOracleConfig = current.config.oracleConfig;
    const desiredOracleConfig = artifact.config.oracleConfig;

    // Remove configs that are no longer needed
    const domainsToRemove = Object.keys(currentOverhead).filter((domainId) =>
      isNullish(desiredOverhead[parseInt(domainId)]),
    );

    for (const domainId of domainsToRemove) {
      transactions.push({
        annotation: `Removing destination gas config for domain ${domainId}`,
        ...this.provider.getRemoveDestinationGasConfigTransaction({
          signer: this.signer.getSignerAddress(),
          hookAddress: artifact.deployed.address,
          remoteDomainId: parseInt(domainId),
        }),
      });
    }

    // Add or update configs
    for (const [domainId, gasOverhead] of Object.entries(desiredOverhead)) {
      const parsedDomainId = parseInt(domainId);

      const oracleConfig = desiredOracleConfig[parsedDomainId];
      if (!oracleConfig) {
        throw new Error(`Missing oracle config for domain ${domainId}`);
      }

      const currentGasOverhead = currentOverhead[parsedDomainId];
      const currentOracle = currentOracleConfig[parsedDomainId];

      // Check if config changed
      const configChanged =
        currentGasOverhead !== gasOverhead ||
        isNullish(currentOracle) ||
        currentOracle.gasPrice !== oracleConfig.gasPrice ||
        currentOracle.tokenExchangeRate !== oracleConfig.tokenExchangeRate;

      if (configChanged) {
        transactions.push({
          annotation: `Setting destination gas config for domain ${domainId}`,
          ...this.provider.getSetDestinationGasConfigTransaction({
            signer: this.signer.getSignerAddress(),
            hookAddress: artifact.deployed.address,
            destinationGasConfig: {
              remoteDomainId: parseInt(domainId),
              gasOracle: {
                tokenExchangeRate: oracleConfig.tokenExchangeRate,
                gasPrice: oracleConfig.gasPrice,
              },
              gasOverhead: gasOverhead.toString(),
            },
          }),
        });
      }
    }

    // Transfer ownership last if changed
    if (!eqAddress(artifact.config.owner, current.config.owner)) {
      transactions.push({
        annotation: `Setting IGP hook owner to ${artifact.config.owner}`,
        ...this.provider.getSetInterchainGasPaymasterHookOwnerTransaction({
          signer: this.signer.getSignerAddress(),
          hookAddress: artifact.deployed.address,
          newOwner: artifact.config.owner,
        }),
      });
    }

    return transactions;
  }
}
