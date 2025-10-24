import { Logger } from 'pino';
import { zeroAddress } from 'viem';

import { AltVM, ProtocolType } from '@hyperlane-xyz/provider-sdk';
import {
  Address,
  Domain,
  addressToBytes32,
  assert,
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

    const transactions = [];

    /**
     * @remark
     * The order of operations matter
     * 1. createOwnershipUpdateTxs() must always be LAST because no updates possible after ownership transferred
     * 2. createRemoteRoutersUpdateTxs() must always be BEFORE createSetDestinationGasUpdateTxs() because gas enumeration depends on domains
     */
    transactions.push(
      ...(await this.createIsmUpdateTxs(actualConfig, expectedConfig)),
      ...(await this.createRemoteRouterUpdateTxs(actualConfig, expectedConfig)),
      ...(await this.createOwnershipUpdateTxs(actualConfig, expectedConfig)),
    );

    return transactions;
  }

  /**
   * Create transactions to update the remote routers for the Warp Route contract.
   *
   * @param actualConfig - The on-chain router configuration, including the remoteRouters array.
   * @param expectedConfig - The expected token router configuration.
   * @returns An array with transactions that need to be executed to enroll the routers
   */
  async createRemoteRouterUpdateTxs(
    actualConfig: DerivedTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
  ): Promise<AnnotatedTypedTransaction<PT>[]> {
    this.logger.debug(`Start creating remote router update transactions`);

    const updateTransactions: AnnotatedTypedTransaction<PT>[] = [];
    if (!expectedConfig.remoteRouters) {
      return [];
    }

    assert(actualConfig.remoteRouters, 'actualRemoteRouters is undefined');
    assert(expectedConfig.remoteRouters, 'expectedRemoteRouters is undefined');

    assert(actualConfig.destinationGas, 'actualDestinationGas is undefined');
    assert(
      expectedConfig.destinationGas,
      'expectedDestinationGas is undefined',
    );

    const { remoteRouters: actualRemoteRouters } = actualConfig;
    const { remoteRouters: expectedRemoteRouters } = expectedConfig;

    const { destinationGas: actualDestinationGas } = actualConfig;
    const { destinationGas: expectedDestinationGas } = expectedConfig;

    // perform checks if domain Ids match between remote router
    // and destination gas configs
    const actualRemoteRoutersString = Object.keys(actualRemoteRouters)
      .sort()
      .toString();
    const actualDestinationGasString = Object.keys(actualDestinationGas)
      .sort()
      .toString();
    const expectedRemoteRoutersString = Object.keys(expectedRemoteRouters)
      .sort()
      .toString();
    const expectedDestinationGasString = Object.keys(expectedDestinationGas)
      .sort()
      .toString();

    assert(
      actualRemoteRoutersString === actualDestinationGasString,
      `domain Ids from actual remote router config differ from actual destination gas config: ${actualRemoteRoutersString} : ${actualDestinationGasString}`,
    );

    assert(
      expectedRemoteRoutersString === expectedDestinationGasString,
      `domain Ids from expected remote router config differ from actual destination gas config: ${expectedRemoteRoutersString} : ${expectedDestinationGasString}`,
    );

    const routesToEnroll = [];
    const routesToUnenroll = [];

    // get domain Ids where we need to enroll, if the address
    // or the gas updates inside a remote route we need to unenroll
    // and enroll again
    for (const domainId of Object.keys(expectedRemoteRouters)) {
      if (!actualRemoteRouters[domainId]) {
        routesToEnroll.push(domainId);
        continue;
      }

      if (
        actualRemoteRouters[domainId].address !==
        expectedRemoteRouters[domainId].address
      ) {
        routesToEnroll.push(domainId);
        routesToUnenroll.push(domainId);
        continue;
      }

      if (actualDestinationGas[domainId] !== expectedDestinationGas[domainId]) {
        routesToEnroll.push(domainId);
        routesToUnenroll.push(domainId);
        continue;
      }
    }

    // get domain Ids where we need to unenroll
    for (const domainId of Object.keys(actualRemoteRouters)) {
      if (!expectedRemoteRouters[domainId]) {
        routesToUnenroll.push(domainId);
      }
    }

    if (routesToEnroll.length === 0 && routesToUnenroll.length === 0) {
      this.logger.debug(`No routes to change. No updates needed.`);
      return [];
    }

    // first be unenroll all routes that need to be unenrolled,
    // afterwards we enroll again
    for (const domainId of routesToUnenroll) {
      updateTransactions.push({
        annotation: `Unenrolling Router ${this.args.addresses.deployedTokenRoute} on ${this.args.chain}`,
        ...(await this.signer.getUnenrollRemoteRouterTransaction({
          signer: actualConfig.owner,
          tokenAddress: this.args.addresses.deployedTokenRoute,
          receiverDomainId: parseInt(domainId),
        })),
      });
    }

    for (const domainId of routesToEnroll) {
      updateTransactions.push({
        annotation: `Enrolling Router ${this.args.addresses.deployedTokenRoute} on ${this.args.chain}`,
        ...(await this.signer.getEnrollRemoteRouterTransaction({
          signer: actualConfig.owner,
          tokenAddress: this.args.addresses.deployedTokenRoute,
          remoteRouter: {
            receiverDomainId: parseInt(domainId),
            receiverAddress: addressToBytes32(
              expectedRemoteRouters[domainId].address,
            ),
            gas: expectedDestinationGas[domainId],
          },
        })),
      });
    }

    this.logger.debug(
      `Created ${updateTransactions.length} remote router update transactions.`,
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
          signer: actualConfig.owner,
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
          signer: actualConfig.owner,
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
      (chain) => this.metadataManager.getChainMetadata(chain),
      (chain) => this.metadataManager.tryGetChainName(chain),
      (chain) => this.metadataManager.tryGetDomainId(chain),
      () => this.metadataManager.getKnownChainNames(),
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
