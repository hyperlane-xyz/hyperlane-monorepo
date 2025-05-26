import { ethers } from 'ethers';

import { InterchainAccountRouter__factory } from '@hyperlane-xyz/core';
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
import { DerivedIcaRouterConfig } from '../ica/types.js';
import { InterchainAccountConfig } from '../index.js';
import { InterchainAccountDeployer } from '../middleware/account/InterchainAccountDeployer.js';
import { InterchainAccountFactories } from '../middleware/account/contracts.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { AnnotatedEV5Transaction } from '../providers/ProviderType.js';
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
  ): Promise<AnnotatedEV5Transaction[]> {
    const actualConfig = await this.read();

    const transactions: AnnotatedEV5Transaction[] = [
      ...(await this.updateRemoteRoutersEnrollment(
        actualConfig.remoteRouters,
        expectedConfig.remoteRouters,
      )),
    ];

    return transactions;
  }

  private async updateRemoteRoutersEnrollment(
    actualConfig: DerivedIcaRouterConfig['remoteRouters'],
    expectedConfig: InterchainAccountConfig['remoteRouters'] = {},
  ): Promise<AnnotatedEV5Transaction[]> {
    const transactions: AnnotatedEV5Transaction[] = [
      ...(await this.getEnrollremoteRoutersTxs(actualConfig, expectedConfig)),
      ...(await this.getUnenrollremoteRoutersTxs(actualConfig, expectedConfig)),
    ];

    return transactions;
  }

  private async getEnrollremoteRoutersTxs(
    actualConfig: Readonly<DerivedIcaRouterConfig['remoteRouters']>,
    expectedConfig: Readonly<InterchainAccountConfig['remoteRouters']> = {},
  ): Promise<AnnotatedEV5Transaction[]> {
    if (!actualConfig) {
      return [];
    }

    const transactions: AnnotatedEV5Transaction[] = [];

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
      remoteIsm.push(ethers.utils.hexZeroPad('0x', 32));
    }

    const remoteTransactions: AnnotatedEV5Transaction[] = domainsToEnroll.map(
      (domainId) => ({
        annotation: `Enrolling InterchainAccountRouter on domain ${this.domainId} on InterchainAccountRouter at ${expectedConfig[domainId].address} on domain ${domainId}`,
        chainId: this.multiProvider.getEvmChainId(domainId),
        to: expectedConfig[domainId].address,
        data: InterchainAccountRouter__factory.createInterface().encodeFunctionData(
          'enrollRemoteRouter(uint32,bytes32)',
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
        'enrollRemoteRouterAndIsms(uint32[],bytes32[],bytes32[])',
        [domainsToEnroll, remoteDomainIca, remoteIsm],
      ),
    });

    transactions.push(...remoteTransactions);

    return transactions;
  }

  private async getUnenrollremoteRoutersTxs(
    actualConfig: Readonly<DerivedIcaRouterConfig['remoteRouters']>,
    expectedConfig: Readonly<InterchainAccountConfig['remoteRouters']> = {},
  ): Promise<AnnotatedEV5Transaction[]> {
    if (!actualConfig) {
      return [];
    }

    const transactions: AnnotatedEV5Transaction[] = [];

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
        'unenrollRemoteRouters(uint32[])',
        [routesToUnenroll],
      ),
    });

    const remoteTransactions: AnnotatedEV5Transaction[] = routesToUnenroll.map(
      (domainId) => ({
        annotation: `Removing InterchainAccountRouter on domain ${this.domainId} from InterchainAccountRouter at ${actualConfig[domainId].address} on domain ${domainId}`,
        chainId: this.multiProvider.getEvmChainId(domainId),
        to: bytes32ToAddress(actualConfig[domainId].address),
        data: InterchainAccountRouter__factory.createInterface().encodeFunctionData(
          'unenrollRemoteRouter(uint32)',
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
