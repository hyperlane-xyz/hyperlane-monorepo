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
import { eqAddressAleo, isNullish } from '@hyperlane-xyz/utils';

import { type AnyAleoNetworkClient } from '../clients/base.js';
import { type AleoSigner } from '../clients/signer.js';
import { getNewContractExpectedNonce } from '../utils/base-query.js';
import { fromAleoAddress, getProgramSuffix } from '../utils/helper.js';
import {
  type AleoReceipt,
  type AnnotatedAleoTransaction,
} from '../utils/types.js';

import { getNewHookAddress } from './base.js';
import { getIgpHookConfig } from './hook-query.js';
import {
  getCreateIgpHookTx,
  getRemoveDestinationGasConfigTx,
  getSetDestinationGasConfigTx,
  getSetIgpHookOwnerTx,
} from './hook-tx.js';

export class AleoIgpHookReader
  implements ArtifactReader<IgpHookConfig, DeployedHookAddress>
{
  constructor(protected readonly aleoClient: AnyAleoNetworkClient) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<IgpHookConfig, DeployedHookAddress>> {
    const hookConfig = await getIgpHookConfig(this.aleoClient, address);

    // Map Aleo config to provider-sdk format
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

export class AleoIgpHookWriter
  extends AleoIgpHookReader
  implements ArtifactWriter<IgpHookConfig, DeployedHookAddress>
{
  constructor(
    aleoClient: AnyAleoNetworkClient,
    private readonly signer: AleoSigner,
    private readonly mailboxAddress: string,
  ) {
    super(aleoClient);
  }

  async create(
    artifact: ArtifactNew<IgpHookConfig>,
  ): Promise<
    [ArtifactDeployed<IgpHookConfig, DeployedHookAddress>, AleoReceipt[]]
  > {
    const { programId } = fromAleoAddress(this.mailboxAddress);
    const suffix = getProgramSuffix(programId);

    const hookManagerProgramId = await this.signer.getHookManager(suffix);

    const transaction = getCreateIgpHookTx(hookManagerProgramId);

    const expectedNonce = await getNewContractExpectedNonce(
      this.aleoClient,
      hookManagerProgramId,
    );

    const receipt = await this.signer.sendAndConfirmTransaction(transaction);
    const hookAddress = await getNewHookAddress(
      this.aleoClient,
      hookManagerProgramId,
      expectedNonce,
    );

    const receipts: AleoReceipt[] = [receipt];

    // Set destination gas configs
    for (const [domainId, gasOverhead] of Object.entries(
      artifact.config.overhead,
    )) {
      const parsedDomainId = parseInt(domainId);

      const oracleConfig = artifact.config.oracleConfig[parsedDomainId];
      if (!oracleConfig) {
        throw new Error(`Missing oracle config for domain ${domainId}`);
      }

      const gasConfigTx = getSetDestinationGasConfigTx(hookAddress, {
        remoteDomainId: parsedDomainId,
        gasOverhead: gasOverhead.toString(),
        tokenExchangeRate: oracleConfig.tokenExchangeRate,
        gasPrice: oracleConfig.gasPrice,
      });

      const gasConfigReceipt =
        await this.signer.sendAndConfirmTransaction(gasConfigTx);
      receipts.push(gasConfigReceipt);
    }

    // Transfer ownership if needed (deployer is initial owner)
    const deployerAddress = this.signer.getSignerAddress();
    if (!eqAddressAleo(artifact.config.owner, deployerAddress)) {
      const ownerTx = getSetIgpHookOwnerTx(hookAddress, artifact.config.owner);
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
        address: hookAddress,
      },
    };

    return [deployedArtifact, receipts];
  }

  async update(
    artifact: ArtifactDeployed<IgpHookConfig, DeployedHookAddress>,
  ): Promise<AnnotatedAleoTransaction[]> {
    const current = await this.read(artifact.deployed.address);
    const transactions: AnnotatedAleoTransaction[] = [];

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
        ...getRemoveDestinationGasConfigTx(
          artifact.deployed.address,
          parseInt(domainId),
        ),
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
          ...getSetDestinationGasConfigTx(artifact.deployed.address, {
            remoteDomainId: parseInt(domainId),
            gasOverhead: gasOverhead.toString(),
            tokenExchangeRate: oracleConfig.tokenExchangeRate,
            gasPrice: oracleConfig.gasPrice,
          }),
        });
      }
    }

    // Transfer ownership last if changed
    if (!eqAddressAleo(artifact.config.owner, current.config.owner)) {
      transactions.push({
        annotation: `Setting IGP hook owner to ${artifact.config.owner}`,
        ...getSetIgpHookOwnerTx(
          artifact.deployed.address,
          artifact.config.owner,
        ),
      });
    }

    return transactions;
  }
}
