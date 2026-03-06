import { MaxUint256, ZeroHash } from 'ethers';

import {
  IERC20__factory,
  InterchainAccountRouter__factory,
} from '@hyperlane-xyz/core';
import {
  Domain,
  EvmChainId,
  ProtocolType,
  addressToBytes32,
  bytes32ToAddress,
  difference,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { serializeContracts } from '../contracts/contracts.js';
import { HyperlaneAddresses } from '../contracts/types.js';
import { ContractVerifier } from '../deploy/verify/ContractVerifier.js';
import { EvmIcaRouterReader } from '../ica/EvmIcaReader.js';
import { DerivedIcaRouterConfig, FeeTokenApproval } from '../ica/types.js';
import { InterchainAccountConfig } from '../index.js';
import { InterchainAccountDeployer } from '../middleware/account/InterchainAccountDeployer.js';
import { InterchainAccountFactories } from '../middleware/account/contracts.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { AnnotatedEvmTransaction } from '../providers/ProviderType.js';
import { ChainNameOrId } from '../types.js';

import {
  HyperlaneModule,
  HyperlaneModuleParams,
} from './AbstractHyperlaneModule.js';

export class EvmIcaModule extends HyperlaneModule<
  ProtocolType.Ethereum,
  InterchainAccountConfig,
  HyperlaneAddresses<InterchainAccountFactories>
> {
  protected logger = rootLogger.child({ module: 'EvmIcaModule' });
  protected icaRouterReader: EvmIcaRouterReader;
  public readonly domainId: Domain;
  public readonly chainId: EvmChainId;

  constructor(
    protected readonly multiProvider: MultiProvider,
    args: HyperlaneModuleParams<
      InterchainAccountConfig,
      HyperlaneAddresses<InterchainAccountFactories>
    >,
  ) {
    super(args);
    this.icaRouterReader = new EvmIcaRouterReader(
      multiProvider,
      this.args.chain,
    );
    this.domainId = multiProvider.getDomainId(args.chain);
    this.chainId = multiProvider.getEvmChainId(args.chain);
  }

  public async read(): Promise<DerivedIcaRouterConfig> {
    return this.icaRouterReader.deriveConfig(
      this.args.addresses.interchainAccountRouter,
    );
  }

  public async update(
    expectedConfig: InterchainAccountConfig,
  ): Promise<AnnotatedEvmTransaction[]> {
    const actualConfig = await this.read();

    const transactions: AnnotatedEvmTransaction[] = [
      ...(await this.updateRemoteRoutersEnrollment(
        actualConfig.remoteRouters,
        expectedConfig.remoteRouters,
      )),
      ...(await this.getFeeTokenApprovalTxs(expectedConfig.feeTokenApprovals)),
    ];

    return transactions;
  }

  private async updateRemoteRoutersEnrollment(
    actualConfig: DerivedIcaRouterConfig['remoteRouters'],
    expectedConfig: InterchainAccountConfig['remoteRouters'] = {},
  ): Promise<AnnotatedEvmTransaction[]> {
    const transactions: AnnotatedEvmTransaction[] = [
      ...(await this.getEnrollRemoteRoutersTxs(actualConfig, expectedConfig)),
      ...(await this.getUnenrollRemoteRoutersTxs(actualConfig, expectedConfig)),
    ];

    return transactions;
  }

  /**
   * Generates transactions to approve fee tokens for hooks.
   * Only generates transactions for approvals that are not already set to max.
   */
  private async getFeeTokenApprovalTxs(
    feeTokenApprovals: FeeTokenApproval[] = [],
  ): Promise<AnnotatedEvmTransaction[]> {
    if (feeTokenApprovals.length === 0) {
      return [];
    }

    const transactions: AnnotatedEvmTransaction[] = [];
    const routerAddress = this.args.addresses.interchainAccountRouter;
    const provider = this.multiProvider.getProvider(this.args.chain);

    for (const approval of feeTokenApprovals) {
      // Check if approval is already set to max
      const token = IERC20__factory.connect(approval.feeToken, provider);
      const currentAllowance = await token.allowance(
        routerAddress,
        approval.hook,
      );

      if (currentAllowance !== MaxUint256) {
        this.logger.debug(
          `Generating approval tx for fee token ${approval.feeToken} to hook ${approval.hook}`,
        );
        transactions.push({
          chainId: this.chainId,
          annotation: `Approving hook ${approval.hook} to spend fee token ${approval.feeToken} on behalf of ICA router ${routerAddress}`,
          to: routerAddress,
          data: InterchainAccountRouter__factory.createInterface().encodeFunctionData(
            'approveFeeTokenForHook',
            [approval.feeToken, approval.hook],
          ),
        });
      }
    }

    return transactions;
  }

  private async getEnrollRemoteRoutersTxs(
    actualConfig: Readonly<DerivedIcaRouterConfig['remoteRouters']>,
    expectedConfig: Readonly<InterchainAccountConfig['remoteRouters']> = {},
  ): Promise<AnnotatedEvmTransaction[]> {
    if (!actualConfig) {
      return [];
    }

    const transactions: AnnotatedEvmTransaction[] = [];

    const routesToEnroll = Array.from(
      difference(
        new Set(Object.keys(expectedConfig)),
        new Set(Object.keys(actualConfig)),
      ),
    );

    if (routesToEnroll.length === 0) {
      return transactions;
    }

    const domainsToEnroll: string[] = [];
    const remoteDomainIca: string[] = [];
    const remoteIsm: string[] = [];

    for (const domainId of routesToEnroll) {
      domainsToEnroll.push(domainId);
      remoteDomainIca.push(addressToBytes32(expectedConfig[domainId].address));
      remoteIsm.push(ZeroHash);
    }

    const remoteTransactions: AnnotatedEvmTransaction[] = domainsToEnroll.map(
      (domainId) => ({
        annotation: `Enrolling InterchainAccountRouter on domain ${this.domainId} on InterchainAccountRouter at ${expectedConfig[domainId].address} on domain ${domainId}`,
        chainId: this.multiProvider.getEvmChainId(domainId),
        to: expectedConfig[domainId].address,
        data: InterchainAccountRouter__factory.createInterface().encodeFunctionData(
          'enrollRemoteRouter',
          [
            this.domainId,
            addressToBytes32(this.args.addresses.interchainAccountRouter),
          ],
        ),
      }),
    );

    transactions.push({
      annotation: `Enrolling remote InterchainAccountRouters on domain ${this.domainId}`,
      chainId: this.chainId,
      to: this.args.addresses.interchainAccountRouter,
      data: InterchainAccountRouter__factory.createInterface().encodeFunctionData(
        'enrollRemoteRouterAndIsms',
        [domainsToEnroll, remoteDomainIca, remoteIsm],
      ),
    });

    transactions.push(...remoteTransactions);

    return transactions;
  }

  private async getUnenrollRemoteRoutersTxs(
    actualConfig: Readonly<DerivedIcaRouterConfig['remoteRouters']>,
    expectedConfig: Readonly<InterchainAccountConfig['remoteRouters']> = {},
  ): Promise<AnnotatedEvmTransaction[]> {
    if (!actualConfig) {
      return [];
    }

    const transactions: AnnotatedEvmTransaction[] = [];

    const routesToUnenroll = Array.from(
      difference(
        new Set(Object.keys(actualConfig)),
        new Set(Object.keys(expectedConfig)),
      ),
    );

    if (routesToUnenroll.length === 0) {
      return transactions;
    }

    transactions.push({
      annotation: `Unenrolling remote InterchainAccountRouters from chain ${this.domainId}`,
      chainId: this.chainId,
      to: this.args.addresses.interchainAccountRouter,
      data: InterchainAccountRouter__factory.createInterface().encodeFunctionData(
        'unenrollRemoteRouters',
        [routesToUnenroll],
      ),
    });

    const remoteTransactions: AnnotatedEvmTransaction[] = routesToUnenroll.map(
      (domainId) => ({
        annotation: `Removing InterchainAccountRouter on domain ${this.domainId} from InterchainAccountRouter at ${actualConfig[domainId].address} on domain ${domainId}`,
        chainId: this.multiProvider.getEvmChainId(domainId),
        to: bytes32ToAddress(actualConfig[domainId].address),
        data: InterchainAccountRouter__factory.createInterface().encodeFunctionData(
          'unenrollRemoteRouter',
          [this.domainId],
        ),
      }),
    );

    transactions.push(...remoteTransactions);

    return transactions;
  }

  /**
   * Creates a new EvmIcaModule instance by deploying an ICA with an ICA ISM.
   *
   * @param chain - The chain on which to deploy the ICA.
   * @param config - The configuration for the ICA.
   * @param multiProvider - The MultiProvider instance to use for deployment.
   * @returns {Promise<EvmIcaModule>} - A new EvmIcaModule instance.
   */
  public static async create({
    chain,
    config,
    multiProvider,
    contractVerifier,
  }: {
    chain: ChainNameOrId;
    config: InterchainAccountConfig;
    multiProvider: MultiProvider;
    contractVerifier?: ContractVerifier;
  }): Promise<EvmIcaModule> {
    const interchainAccountDeployer = new InterchainAccountDeployer(
      multiProvider,
      contractVerifier,
    );
    const deployedContracts = await interchainAccountDeployer.deployContracts(
      multiProvider.getChainName(chain),
      config,
    );

    return new EvmIcaModule(multiProvider, {
      addresses: serializeContracts(deployedContracts),
      chain,
      config,
    });
  }
}
