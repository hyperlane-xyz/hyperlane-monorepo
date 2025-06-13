import { zeroAddress } from 'viem';

import {
  COSMOS_MODULE_MESSAGE_REGISTRY as R,
  SigningHyperlaneModuleClient,
} from '@hyperlane-xyz/cosmos-sdk';
import {
  Address,
  Domain,
  ProtocolType,
  addressToBytes32,
  assert,
  deepEquals,
  difference,
  eqAddress,
  isObjEmpty,
  objMap,
  rootLogger,
} from '@hyperlane-xyz/utils';

import {
  HyperlaneModule,
  HyperlaneModuleParams,
} from '../core/AbstractHyperlaneModule.js';
import { CosmosNativeIsmModule } from '../ism/CosmosNativeIsmModule.js';
import { DerivedIsmConfig } from '../ism/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { AnnotatedCosmJsNativeTransaction } from '../providers/ProviderType.js';
import { ChainName, ChainNameOrId } from '../types.js';

import { CosmosNativeWarpRouteReader } from './CosmosNativeWarpRouteReader.js';
import { TokenType } from './config.js';
import { HypTokenRouterConfig, HypTokenRouterConfigSchema } from './types.js';

type WarpRouteAddresses = {
  deployedTokenRoute: Address;
};

export class CosmosNativeWarpModule extends HyperlaneModule<
  ProtocolType.CosmosNative,
  HypTokenRouterConfig,
  WarpRouteAddresses
> {
  protected logger = rootLogger.child({
    module: 'CosmosNativeWarpModule',
  });
  reader: CosmosNativeWarpRouteReader;
  public readonly chainName: ChainName;
  public readonly chainId: string;
  public readonly domainId: Domain;

  constructor(
    protected readonly multiProvider: MultiProvider,
    args: HyperlaneModuleParams<HypTokenRouterConfig, WarpRouteAddresses>,
    protected readonly signer: SigningHyperlaneModuleClient,
  ) {
    super(args);
    this.reader = new CosmosNativeWarpRouteReader(
      multiProvider,
      args.chain,
      signer,
    );
    this.chainName = this.multiProvider.getChainName(args.chain);
    this.chainId = multiProvider.getChainId(args.chain).toString();
    this.domainId = multiProvider.getDomainId(args.chain);
  }

  /**
   * Retrieves the token router configuration for the specified address.
   *
   * @param address - The address to derive the token router configuration from.
   * @returns A promise that resolves to the token router configuration.
   */
  async read(): Promise<HypTokenRouterConfig> {
    return this.reader.deriveWarpRouteConfig(
      this.args.addresses.deployedTokenRoute,
    );
  }

  /**
   * Updates the Warp Route contract with the provided configuration.
   *
   * @param expectedConfig - The configuration for the token router to be updated.
   * @returns An array of Cosmos transactions that were executed to update the contract, or an error if the update failed.
   */
  async update(
    expectedConfig: HypTokenRouterConfig,
  ): Promise<AnnotatedCosmJsNativeTransaction[]> {
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
      ...this.createEnrollRemoteRoutersUpdateTxs(actualConfig, expectedConfig),
      ...this.createUnenrollRemoteRoutersUpdateTxs(
        actualConfig,
        expectedConfig,
      ),
      ...(await this.createSetDestinationGasUpdateTxs(
        actualConfig,
        expectedConfig,
      )),
      ...this.createOwnershipUpdateTxs(actualConfig, expectedConfig),
    );

    return transactions;
  }

  /**
   * Create a transaction to update the remote routers for the Warp Route contract.
   *
   * @param actualConfig - The on-chain router configuration, including the remoteRouters array.
   * @param expectedConfig - The expected token router configuration.
   * @returns A array with a single Ethereum transaction that need to be executed to enroll the routers
   */
  createEnrollRemoteRoutersUpdateTxs(
    actualConfig: HypTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
  ): AnnotatedCosmJsNativeTransaction[] {
    const updateTransactions: AnnotatedCosmJsNativeTransaction[] = [];
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

    // in cosmos the gas is attached to the remote router. we set
    // it to zero for now and set the real value later during the
    // createSetDestinationGasUpdateTxs step
    routesToEnroll.forEach((domainId) => {
      updateTransactions.push({
        annotation: `Enrolling Router ${this.args.addresses.deployedTokenRoute} on ${this.args.chain}`,
        typeUrl: R.MsgEnrollRemoteRouter.proto.type,
        value: R.MsgEnrollRemoteRouter.proto.converter.create({
          owner: actualConfig.owner,
          token_id: this.args.addresses.deployedTokenRoute,
          remote_router: {
            receiver_domain: parseInt(domainId),
            receiver_contract: addressToBytes32(
              expectedRemoteRouters[domainId].address,
            ),
            gas: '0',
          },
        }),
      });
    });

    return updateTransactions;
  }

  createUnenrollRemoteRoutersUpdateTxs(
    actualConfig: HypTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
  ): AnnotatedCosmJsNativeTransaction[] {
    const updateTransactions: AnnotatedCosmJsNativeTransaction[] = [];
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

    routesToUnenroll.forEach((domainId) => {
      updateTransactions.push({
        annotation: `Unenrolling Router ${this.args.addresses.deployedTokenRoute} on ${this.args.chain}`,
        typeUrl: R.MsgUnrollRemoteRouter.proto.type,
        value: R.MsgUnrollRemoteRouter.proto.converter.create({
          owner: actualConfig.owner,
          token_id: this.args.addresses.deployedTokenRoute,
          receiver_domain: parseInt(domainId),
        }),
      });
    });

    return updateTransactions;
  }

  /**
   * Create a transaction to update the remote routers for the Warp Route contract.
   *
   * @param actualConfig - The on-chain router configuration, including the remoteRouters array.
   * @param expectedConfig - The expected token router configuration.
   * @returns A array with Cosmos transactions that need to be executed to update the destination gas
   */
  async createSetDestinationGasUpdateTxs(
    actualConfig: HypTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
  ): Promise<AnnotatedCosmJsNativeTransaction[]> {
    const updateTransactions: AnnotatedCosmJsNativeTransaction[] = [];
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
      await this.signer.query.warp.RemoteRouters({
        id: this.args.addresses.deployedTokenRoute,
      });

    const alreadyEnrolledDomains = actualRemoteRouters.map(
      (router) => router.receiver_domain,
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

      // in cosmos updating the gas config is done by unenrolling the router and then
      // enrolling it with the updating value again
      gasRouterConfigs.forEach(({ domain, gas }) => {
        if (alreadyEnrolledDomains.includes(parseInt(domain))) {
          updateTransactions.push({
            annotation: `Unenrolling ${this.args.addresses.deployedTokenRoute} on ${this.args.chain}`,
            typeUrl: R.MsgUnrollRemoteRouter.proto.type,
            value: R.MsgUnrollRemoteRouter.proto.converter.create({
              owner: actualConfig.owner,
              token_id: this.args.addresses.deployedTokenRoute,
              receiver_domain: parseInt(domain),
            }),
          });
        }

        updateTransactions.push({
          annotation: `Setting destination gas for ${this.args.addresses.deployedTokenRoute} on ${this.args.chain}`,
          typeUrl: R.MsgEnrollRemoteRouter.proto.type,
          value: R.MsgEnrollRemoteRouter.proto.converter.create({
            owner: actualConfig.owner,
            token_id: this.args.addresses.deployedTokenRoute,
            remote_router: {
              receiver_domain: parseInt(domain),
              receiver_contract: addressToBytes32(
                expectedRemoteRouters[domain].address,
              ),
              gas,
            },
          }),
        });
      });
    }

    return updateTransactions;
  }

  /**
   * Create transactions to update an existing ISM config, or deploy a new ISM and return a tx to setInterchainSecurityModule
   *
   * @param actualConfig - The on-chain router configuration, including the ISM configuration, and address.
   * @param expectedConfig - The expected token router configuration, including the ISM configuration.
   * @returns Cosmos transaction that need to be executed to update the ISM configuration.
   */
  async createIsmUpdateTxs(
    actualConfig: HypTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
  ): Promise<AnnotatedCosmJsNativeTransaction[]> {
    const updateTransactions: AnnotatedCosmJsNativeTransaction[] = [];
    if (
      !expectedConfig.interchainSecurityModule ||
      expectedConfig.interchainSecurityModule === zeroAddress
    ) {
      return [];
    }

    const actualDeployedIsm = (
      actualConfig.interchainSecurityModule as DerivedIsmConfig
    ).address;

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
        typeUrl: R.MsgSetToken.proto.type,
        value: R.MsgSetToken.proto.converter.create({
          owner: actualConfig.owner,
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
   * @returns Cosmos transaction that need to be executed to update the owner.
   */
  createOwnershipUpdateTxs(
    actualConfig: HypTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
  ): AnnotatedCosmJsNativeTransaction[] {
    if (eqAddress(actualConfig.owner, expectedConfig.owner)) {
      return [];
    }

    return [
      {
        annotation: `Transferring ownership of ${this.args.addresses.deployedTokenRoute} from ${actualConfig.owner} to ${expectedConfig.owner}`,
        typeUrl: R.MsgSetToken.proto.type,
        value: R.MsgSetToken.proto.converter.create({
          owner: actualConfig.owner,
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
    actualConfig: HypTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
  ): Promise<{
    deployedIsm: Address;
    updateTransactions: AnnotatedCosmJsNativeTransaction[];
  }> {
    assert(expectedConfig.interchainSecurityModule, 'Ism derived incorrectly');

    const ismModule = new CosmosNativeIsmModule(
      this.multiProvider,
      {
        chain: this.args.chain,
        config: expectedConfig.interchainSecurityModule,
        addresses: {
          ...this.args.addresses,
          mailbox: expectedConfig.mailbox,
          deployedIsm: (
            actualConfig.interchainSecurityModule as DerivedIsmConfig
          ).address,
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
   * @param signer - The Cosmos signing client
   * @returns A new instance of the CosmosNativeWarpModule.
   */
  static async create(params: {
    chain: ChainNameOrId;
    config: HypTokenRouterConfig;
    multiProvider: MultiProvider;
    signer: SigningHyperlaneModuleClient;
  }): Promise<CosmosNativeWarpModule> {
    const { chain, config, multiProvider, signer } = params;

    let deployedTokenRoute: string = '';

    if (config.type === TokenType.collateral) {
      // TODO: is config.token the origin denom?
      const { response } = await signer.createCollateralToken({
        origin_mailbox: config.mailbox,
        origin_denom: config.token,
      });
      deployedTokenRoute = response.id;
    } else if (config.type === TokenType.synthetic) {
      const { response } = await signer.createSyntheticToken({
        origin_mailbox: config.mailbox,
      });
      deployedTokenRoute = response.id;
    }

    if (!deployedTokenRoute) {
      throw new Error(`failed to deploy token route`);
    }

    const warpModule = new CosmosNativeWarpModule(
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

    if (config.remoteRouters && !isObjEmpty(config.remoteRouters)) {
      const enrollRemoteTxs = await warpModule.update(config); // @TODO Remove when CosmosNativeWarpModule.create can be used
      const onlyTxIndex = 0;
      await multiProvider.sendTransaction(chain, enrollRemoteTxs[onlyTxIndex]);
    }

    return warpModule;
  }
}
