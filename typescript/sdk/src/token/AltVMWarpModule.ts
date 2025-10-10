import { Logger } from 'pino';
import { zeroAddress } from 'viem';

import {
  Address,
  AltVM,
  Domain,
  ProtocolType,
  addressToBytes32,
  assert,
  deepEquals,
  difference,
  objMap,
  rootLogger,
} from '@hyperlane-xyz/utils';

import {
  HyperlaneModule,
  HyperlaneModuleParams,
} from '../core/AbstractHyperlaneModule.js';
import { AltVMIsmModule } from '../ism/AltVMIsmModule.js';
import { DerivedIsmConfig } from '../ism/types.js';
import { ChainMetadataManager } from '../metadata/ChainMetadataManager.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import {
  AnnotatedTypedTransaction,
  ProtocolReceipt,
  ProtocolTransaction,
} from '../providers/ProviderType.js';
import { ChainName, ChainNameOrId } from '../types.js';

import { AltVMWarpRouteReader } from './AltVMWarpRouteReader.js';
import { AltVMDeployer } from './altVMDeploy.js';
import {
  DerivedTokenRouterConfig,
  HypTokenRouterConfig,
  HypTokenRouterConfigSchema,
} from './types.js';

type WarpRouteAddresses = {
  deployedTokenRoute: Address;
};

export class AltVMWarpModule<PT extends ProtocolType> extends HyperlaneModule<
  PT,
  HypTokenRouterConfig,
  WarpRouteAddresses
> {
  protected logger: Logger;

  reader: AltVMWarpRouteReader;
  public readonly chainName: ChainName;
  public readonly chainId: string;
  public readonly domainId: Domain;

  constructor(
    protected readonly metadataManager: ChainMetadataManager,
    args: HyperlaneModuleParams<HypTokenRouterConfig, WarpRouteAddresses>,
    protected readonly signer: AltVM.ISigner<
      AnnotatedTypedTransaction<PT>,
      ProtocolReceipt<PT>
    >,
  ) {
    super(args);
    this.reader = new AltVMWarpRouteReader(metadataManager, args.chain, signer);
    this.chainName = this.metadataManager.getChainName(args.chain);
    this.chainId = metadataManager.getChainId(args.chain).toString();
    this.domainId = metadataManager.getDomainId(args.chain);

    this.logger = rootLogger.child({
      module: AltVMWarpModule.name,
    });
  }

  /**
   * Retrieves the token router configuration for the specified address.
   *
   * @param address - The address to derive the token router configuration from.
   * @returns A promise that resolves to the token router configuration.
   */
  async read(): Promise<DerivedTokenRouterConfig> {
    return this.reader.deriveWarpRouteConfig(
      this.args.addresses.deployedTokenRoute,
    );
  }

  /**
   * Updates the Warp Route contract with the provided configuration.
   *
   * @param expectedConfig - The configuration for the token router to be updated.
   * @returns An array of transactions that were executed to update the contract, or an error if the update failed.
   */
  async update(
    expectedConfig: HypTokenRouterConfig,
  ): Promise<AnnotatedTypedTransaction<PT>[]> {
    HypTokenRouterConfigSchema.parse(expectedConfig);
    const actualConfig = await this.read();

    assert(
      this.signer.getSignerAddress() === actualConfig.owner,
      `Deployer key (${this.signer.getSignerAddress()}) is not the Token owner (${actualConfig.owner}). Aborting`,
    );

    const transactions = [];

    /**
     * @remark
     * The order of operations matter
     * 1. createOwnershipUpdateTxs() must always be LAST because no updates possible after ownership transferred
     * 2. createRemoteRoutersUpdateTxs() must always be BEFORE createSetDestinationGasUpdateTxs() because gas enumeration depends on domains
     */
    transactions.push(
      ...(await this.createIsmUpdateTxs(actualConfig, expectedConfig)),
      ...(await this.createEnrollRemoteRoutersUpdateTxs(
        actualConfig,
        expectedConfig,
      )),
      ...(await this.createUnenrollRemoteRoutersUpdateTxs(
        actualConfig,
        expectedConfig,
      )),
      ...(await this.createSetDestinationGasUpdateTxs(
        actualConfig,
        expectedConfig,
      )),
      ...(await this.createOwnershipUpdateTxs(actualConfig, expectedConfig)),
    );

    return transactions;
  }

  /**
   * Create a transaction to update the remote routers for the Warp Route contract.
   *
   * @param actualConfig - The on-chain router configuration, including the remoteRouters array.
   * @param expectedConfig - The expected token router configuration.
   * @returns An array with transactions that need to be executed to enroll the routers
   */
  async createEnrollRemoteRoutersUpdateTxs(
    actualConfig: DerivedTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
  ): Promise<AnnotatedTypedTransaction<PT>[]> {
    this.logger.debug(`Start creating ISM update transactions`);

    const updateTransactions: AnnotatedTypedTransaction<PT>[] = [];
    if (!expectedConfig.remoteRouters) {
      return [];
    }

    assert(actualConfig.remoteRouters, 'actualRemoteRouters is undefined');
    assert(expectedConfig.remoteRouters, 'expectedRemoteRouters is undefined');

    const { remoteRouters: actualRemoteRouters } = actualConfig;
    const { remoteRouters: expectedRemoteRouters } = expectedConfig;

    const routesToEnroll = Object.entries(expectedRemoteRouters)
      .filter(([domain, expectedRouter]) => {
        const actualRouter = actualRemoteRouters[domain];
        // Enroll if router doesn't exist for domain or has different address
        return !actualRouter || actualRouter.address !== expectedRouter.address;
      })
      .map(([domain]) => domain);

    if (routesToEnroll.length === 0) {
      this.logger.debug(`No routes to enroll. No updates needed.`);
      return updateTransactions;
    }

    // we set the gas to zero for now and set the real value later during the
    // createSetDestinationGasUpdateTxs step
    for (const domainId of routesToEnroll) {
      updateTransactions.push({
        annotation: `Enrolling Router ${this.args.addresses.deployedTokenRoute} on ${this.args.chain}`,
        ...(await this.signer.getEnrollRemoteRouterTransaction({
          signer: this.signer.getSignerAddress(),
          tokenAddress: this.args.addresses.deployedTokenRoute,
          remoteRouter: {
            receiverDomainId: parseInt(domainId),
            receiverAddress: addressToBytes32(
              expectedRemoteRouters[domainId].address,
            ),
            gas: '0',
          },
        })),
      });
    }

    this.logger.debug(
      `Created ${updateTransactions.length} enroll router update transactions.`,
    );

    return updateTransactions;
  }

  async createUnenrollRemoteRoutersUpdateTxs(
    actualConfig: DerivedTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
  ): Promise<AnnotatedTypedTransaction<PT>[]> {
    this.logger.debug(`Start creating remote router unenroll transactions`);

    const updateTransactions: AnnotatedTypedTransaction<PT>[] = [];
    if (!expectedConfig.remoteRouters) {
      this.logger.debug(`No routes to unenroll. No updates needed.`);
      return [];
    }

    assert(actualConfig.remoteRouters, 'actualRemoteRouters is undefined');
    assert(expectedConfig.remoteRouters, 'expectedRemoteRouters is undefined');

    const { remoteRouters: actualRemoteRouters } = actualConfig;
    const { remoteRouters: expectedRemoteRouters } = expectedConfig;

    const routesToUnenroll = Array.from(
      difference(
        new Set(Object.keys(actualRemoteRouters)),
        new Set(Object.keys(expectedRemoteRouters)),
      ),
    );

    if (routesToUnenroll.length === 0) {
      return updateTransactions;
    }

    for (const domainId of routesToUnenroll) {
      updateTransactions.push({
        annotation: `Unenrolling Router ${this.args.addresses.deployedTokenRoute} on ${this.args.chain}`,
        ...(await this.signer.getUnenrollRemoteRouterTransaction({
          signer: this.signer.getSignerAddress(),
          tokenAddress: this.args.addresses.deployedTokenRoute,
          receiverDomainId: parseInt(domainId),
        })),
      });
    }

    this.logger.debug(
      `Created ${updateTransactions.length} unenroll router update transactions.`,
    );

    return updateTransactions;
  }

  /**
   * Create a transaction to update the remote routers for the Warp Route contract.
   *
   * @param actualConfig - The on-chain router configuration, including the remoteRouters array.
   * @param expectedConfig - The expected token router configuration.
   * @returns A array with transactions that need to be executed to update the destination gas
   */
  async createSetDestinationGasUpdateTxs(
    actualConfig: DerivedTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
  ): Promise<AnnotatedTypedTransaction<PT>[]> {
    this.logger.debug(`Start creating set destination gas transactions`);

    const updateTransactions: AnnotatedTypedTransaction<PT>[] = [];
    if (!expectedConfig.destinationGas) {
      this.logger.debug(
        `No gas destination configs to set. No updates needed.`,
      );
      return [];
    }

    assert(actualConfig.destinationGas, 'actualDestinationGas is undefined');
    assert(
      expectedConfig.destinationGas,
      'expectedDestinationGas is undefined',
    );
    assert(expectedConfig.remoteRouters, 'expectedRemoteRouters is undefined');

    const { destinationGas: actualDestinationGas } = actualConfig;
    const { destinationGas: expectedDestinationGas } = expectedConfig;
    const { remoteRouters: expectedRemoteRouters } = expectedConfig;

    // refetch after routes have been previously enrolled without the "actualConfig"
    // updating
    const { remoteRouters: actualRemoteRouters } =
      await this.signer.getRemoteRouters({
        tokenAddress: this.args.addresses.deployedTokenRoute,
      });

    const alreadyEnrolledDomains = actualRemoteRouters.map(
      (router) => router.receiverDomainId,
    );

    if (!deepEquals(actualDestinationGas, expectedDestinationGas)) {
      // Convert { 1: 2, 2: 3, ... } to [{ 1: 2 }, { 2: 3 }]
      const gasRouterConfigs: { domain: string; gas: string }[] = [];
      objMap(expectedDestinationGas, (domain: string, gas: string) => {
        gasRouterConfigs.push({
          domain,
          gas,
        });
      });

      // to update the gas config we unenroll the router and then
      // enrolling it with the updating value again

      for (const { domain, gas } of gasRouterConfigs) {
        if (alreadyEnrolledDomains.includes(parseInt(domain))) {
          updateTransactions.push({
            annotation: `Unenrolling ${this.args.addresses.deployedTokenRoute} on ${this.args.chain}`,
            ...(await this.signer.getUnenrollRemoteRouterTransaction({
              signer: this.signer.getSignerAddress(),
              tokenAddress: this.args.addresses.deployedTokenRoute,
              receiverDomainId: parseInt(domain),
            })),
          });
        }

        updateTransactions.push({
          annotation: `Setting destination gas for ${this.args.addresses.deployedTokenRoute} on ${this.args.chain} to ${gas}`,
          ...(await this.signer.getEnrollRemoteRouterTransaction({
            signer: this.signer.getSignerAddress(),
            tokenAddress: this.args.addresses.deployedTokenRoute,
            remoteRouter: {
              receiverDomainId: parseInt(domain),
              receiverAddress: addressToBytes32(
                expectedRemoteRouters[domain].address,
              ),
              gas,
            },
          })),
        });
      }
    }

    this.logger.debug(
      `Created ${updateTransactions.length} set destination gas update transactions.`,
    );

    return updateTransactions;
  }

  /**
   * Create transactions to update an existing ISM config, or deploy a new ISM and return a tx to setInterchainSecurityModule
   *
   * @param actualConfig - The on-chain router configuration, including the ISM configuration, and address.
   * @param expectedConfig - The expected token router configuration, including the ISM configuration.
   * @returns transaction that need to be executed to update the ISM configuration.
   */
  async createIsmUpdateTxs(
    actualConfig: DerivedTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
  ): Promise<AnnotatedTypedTransaction<PT>[]> {
    this.logger.debug(`Start creating token ISM update transactions`);

    const updateTransactions: AnnotatedTypedTransaction<PT>[] = [];

    if (
      actualConfig.interchainSecurityModule ===
      expectedConfig.interchainSecurityModule
    ) {
      this.logger.debug(
        `Token ISM config is the same as target. No updates needed.`,
      );
      return updateTransactions;
    }

    if (
      !expectedConfig.interchainSecurityModule ||
      expectedConfig.interchainSecurityModule === zeroAddress
    ) {
      this.logger.debug(`Token ISM config is empty. No updates needed.`);
      return updateTransactions;
    }

    const actualDeployedIsm =
      (actualConfig.interchainSecurityModule as DerivedIsmConfig)?.address ??
      '';

    // Try to update (may also deploy) Ism with the expected config
    const {
      deployedIsm: expectedDeployedIsm,
      updateTransactions: ismUpdateTransactions,
    } = await this.deployOrUpdateIsm(actualConfig, expectedConfig);

    // If an ISM is updated in-place, push the update txs
    updateTransactions.push(...ismUpdateTransactions);

    // If a new ISM is deployed, push the setInterchainSecurityModule tx
    if (actualDeployedIsm !== expectedDeployedIsm) {
      updateTransactions.push({
        annotation: `Setting ISM for Warp Route to ${expectedDeployedIsm}`,
        ...(await this.signer.getSetTokenIsmTransaction({
          signer: this.signer.getSignerAddress(),
          tokenAddress: this.args.addresses.deployedTokenRoute,
          ismAddress: expectedDeployedIsm,
        })),
      });
    }

    this.logger.debug(
      `Created ${updateTransactions.length} update token ISM transactions.`,
    );

    return updateTransactions;
  }

  /**
   * Transfer ownership of an existing Warp route with a given config.
   *
   * @param actualConfig - The on-chain router configuration.
   * @param expectedConfig - The expected token router configuration.
   * @returns transaction that need to be executed to update the owner.
   */
  async createOwnershipUpdateTxs(
    actualConfig: DerivedTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
  ): Promise<AnnotatedTypedTransaction<PT>[]> {
    this.logger.debug(`Start creating token owner update transactions`);

    if (actualConfig.owner === expectedConfig.owner) {
      this.logger.debug(
        `Token owner is the same as target. No updates needed.`,
      );
      return [];
    }

    this.logger.debug(`Created 1 update token owner update transaction.`);

    return [
      {
        annotation: `Transferring ownership of ${this.args.addresses.deployedTokenRoute} from ${actualConfig.owner} to ${expectedConfig.owner}`,
        ...(await this.signer.getSetTokenOwnerTransaction({
          signer: this.signer.getSignerAddress(),
          tokenAddress: this.args.addresses.deployedTokenRoute,
          newOwner: expectedConfig.owner,
        })),
      },
    ];
  }

  /**
   * Updates or deploys the ISM using the provided configuration.
   *
   * @returns Object with deployedIsm address, and update Transactions
   */
  async deployOrUpdateIsm(
    actualConfig: DerivedTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
  ): Promise<{
    deployedIsm: Address;
    updateTransactions: AnnotatedTypedTransaction<PT>[];
  }> {
    this.logger.debug(`Start deploying token ISM`);

    assert(expectedConfig.interchainSecurityModule, 'Ism derived incorrectly');

    const ismModule = new AltVMIsmModule(
      this.metadataManager,
      {
        chain: this.args.chain,
        config: expectedConfig.interchainSecurityModule,
        addresses: {
          ...this.args.addresses,
          mailbox: expectedConfig.mailbox,
          deployedIsm:
            (actualConfig.interchainSecurityModule as DerivedIsmConfig)
              ?.address ?? '',
        },
      },
      this.signer,
    );
    this.logger.debug(
      `Comparing target ISM config with ${this.args.chain} chain`,
    );
    const updateTransactions = await ismModule.update(
      expectedConfig.interchainSecurityModule,
    );
    const { deployedIsm } = ismModule.serialize();

    return { deployedIsm, updateTransactions };
  }

  /**
   * Deploys the Warp Route.
   *
   * @param chain - The chain to deploy the module on.
   * @param config - The configuration for the token router.
   * @param multiProvider - The multi-provider instance to use.
   * @param signer - The AltVM signing client
   * @returns A new instance of the AltVMWarpModule.
   */
  static async create<PT extends ProtocolType>(params: {
    chain: ChainNameOrId;
    config: HypTokenRouterConfig;
    multiProvider: MultiProvider;
    signer: AltVM.ISigner<ProtocolTransaction<PT>, ProtocolReceipt<PT>>;
  }): Promise<AltVMWarpModule<PT>> {
    const { chain, config, multiProvider, signer } = params;

    const deployer = new AltVMDeployer(multiProvider, {
      [chain]: signer,
    });

    const { [chain]: deployedTokenRoute } = await deployer.deploy({
      [chain]: config,
    });

    const warpModule = new AltVMWarpModule<PT>(
      multiProvider,
      {
        addresses: {
          deployedTokenRoute,
        },
        chain,
        config,
      },
      signer,
    );

    return warpModule;
  }
}
