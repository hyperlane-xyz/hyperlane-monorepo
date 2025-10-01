import { zeroAddress } from 'viem';

import {
  Address,
  Domain,
  MultiVM,
  addressToBytes32,
  assert,
  deepEquals,
  difference,
  eqAddress,
  objMap,
  rootLogger,
} from '@hyperlane-xyz/utils';

import {
  HyperlaneModule,
  HyperlaneModuleParams,
} from '../core/AbstractHyperlaneModule.js';
import { MultiVmIsmModule } from '../ism/MultiVmIsmModule.js';
import { DerivedIsmConfig } from '../ism/types.js';
import { ChainMetadataManager } from '../metadata/ChainMetadataManager.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { MultiVmTransaction } from '../providers/ProviderType.js';
import { ChainName, ChainNameOrId } from '../types.js';

import { MultiVmWarpRouteReader } from './MultiVmWarpRouteReader.js';
import { MultiVmDeployer } from './multiVmDeploy.js';
import {
  DerivedTokenRouterConfig,
  HypTokenRouterConfig,
  HypTokenRouterConfigSchema,
} from './types.js';

type WarpRouteAddresses = {
  deployedTokenRoute: Address;
};

export class MultiVmWarpModule extends HyperlaneModule<
  any,
  HypTokenRouterConfig,
  WarpRouteAddresses
> {
  protected logger = rootLogger.child({
    module: 'MultiVmWarpModule',
  });
  reader: MultiVmWarpRouteReader;
  public readonly chainName: ChainName;
  public readonly chainId: string;
  public readonly domainId: Domain;

  constructor(
    protected readonly metadataManager: ChainMetadataManager,
    args: HyperlaneModuleParams<HypTokenRouterConfig, WarpRouteAddresses>,
    protected readonly signer: MultiVM.IMultiVMSigner,
  ) {
    super(args);
    this.reader = new MultiVmWarpRouteReader(
      metadataManager,
      args.chain,
      signer,
    );
    this.chainName = this.metadataManager.getChainName(args.chain);
    this.chainId = metadataManager.getChainId(args.chain).toString();
    this.domainId = metadataManager.getDomainId(args.chain);
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
  ): Promise<MultiVmTransaction[]> {
    HypTokenRouterConfigSchema.parse(expectedConfig);
    const actualConfig = await this.read();

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
  ): Promise<MultiVmTransaction[]> {
    const updateTransactions: MultiVmTransaction[] = [];
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
        return (
          !actualRouter ||
          !eqAddress(actualRouter.address, expectedRouter.address)
        );
      })
      .map(([domain]) => domain);

    if (routesToEnroll.length === 0) {
      return updateTransactions;
    }

    // we set the gas to zero for now and set the real value later during the
    // createSetDestinationGasUpdateTxs step
    for (const domainId of routesToEnroll) {
      updateTransactions.push({
        annotation: `Enrolling Router ${this.args.addresses.deployedTokenRoute} on ${this.args.chain}`,
        transaction: await this.signer.populateEnrollRemoteRouter({
          signer: this.signer.getSignerAddress(),
          token_id: this.args.addresses.deployedTokenRoute,
          receiver_domain_id: parseInt(domainId),
          receiver_address: addressToBytes32(
            expectedRemoteRouters[domainId].address,
          ),
          gas: '0',
        }),
      });
    }

    return updateTransactions;
  }

  async createUnenrollRemoteRoutersUpdateTxs(
    actualConfig: DerivedTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
  ): Promise<MultiVmTransaction[]> {
    const updateTransactions: MultiVmTransaction[] = [];
    if (!expectedConfig.remoteRouters) {
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
        transaction: await this.signer.populateUnenrollRemoteRouter({
          signer: this.signer.getSignerAddress(),
          token_id: this.args.addresses.deployedTokenRoute,
          receiver_domain_id: parseInt(domainId),
        }),
      });
    }

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
  ): Promise<MultiVmTransaction[]> {
    const updateTransactions: MultiVmTransaction[] = [];
    if (!expectedConfig.destinationGas) {
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
    const { remote_routers: actualRemoteRouters } =
      await this.signer.getRemoteRouters({
        token_id: this.args.addresses.deployedTokenRoute,
      });

    const alreadyEnrolledDomains = actualRemoteRouters.map(
      (router) => router.receiver_domain_id,
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
            transaction: await this.signer.populateUnenrollRemoteRouter({
              signer: this.signer.getSignerAddress(),
              token_id: this.args.addresses.deployedTokenRoute,
              receiver_domain_id: parseInt(domain),
            }),
          });
        }

        updateTransactions.push({
          annotation: `Setting destination gas for ${this.args.addresses.deployedTokenRoute} on ${this.args.chain} to ${gas}`,
          transaction: await this.signer.populateEnrollRemoteRouter({
            signer: this.signer.getSignerAddress(),
            token_id: this.args.addresses.deployedTokenRoute,
            receiver_domain_id: parseInt(domain),
            receiver_address: addressToBytes32(
              expectedRemoteRouters[domain].address,
            ),
            gas: '0',
          }),
        });
      }
    }

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
  ): Promise<MultiVmTransaction[]> {
    const updateTransactions: MultiVmTransaction[] = [];

    if (
      actualConfig.interchainSecurityModule ===
      expectedConfig.interchainSecurityModule
    ) {
      return updateTransactions;
    }

    if (
      !expectedConfig.interchainSecurityModule ||
      expectedConfig.interchainSecurityModule === zeroAddress
    ) {
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
        transaction: await this.signer.populateSetTokenIsm({
          signer: this.signer.getSignerAddress(),
          token_id: this.args.addresses.deployedTokenRoute,
          ism_id: expectedDeployedIsm,
        }),
      });
    }

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
  ): Promise<MultiVmTransaction[]> {
    if (eqAddress(actualConfig.owner, expectedConfig.owner)) {
      return [];
    }

    return [
      {
        annotation: `Transferring ownership of ${this.args.addresses.deployedTokenRoute} from ${actualConfig.owner} to ${expectedConfig.owner}`,
        transaction: await this.signer.populateSetTokenOwner({
          signer: this.signer.getSignerAddress(),
          token_id: this.args.addresses.deployedTokenRoute,
          new_owner: expectedConfig.owner,
        }),
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
    updateTransactions: MultiVmTransaction[];
  }> {
    assert(expectedConfig.interchainSecurityModule, 'Ism derived incorrectly');

    const ismModule = new MultiVmIsmModule(
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
    this.logger.info(
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
   * @param signer - The MultiVM signing client
   * @returns A new instance of the MultiVmWarpModule.
   */
  static async create(params: {
    chain: ChainNameOrId;
    config: HypTokenRouterConfig;
    multiProvider: MultiProvider;
    signer: MultiVM.IMultiVMSigner;
  }): Promise<MultiVmWarpModule> {
    const { chain, config, multiProvider, signer } = params;

    const deployer = new MultiVmDeployer(multiProvider, {
      [chain]: signer,
    });

    const { [chain]: deployedTokenRoute } = await deployer.deploy({
      [chain]: config,
    });

    const warpModule = new MultiVmWarpModule(
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
