import { ethers } from 'ethers';

import {
  CctpAdapter__factory,
  ProxyAdmin__factory,
} from '../../../../../solidity/dist';
import { HyperlaneContracts, HyperlaneContractsMap } from '../../contracts';
import { MultiProvider } from '../../providers/MultiProvider';
import { ProxiedRouterDeployer } from '../../router/ProxiedRouterDeployer';
import { RouterConfig } from '../../router/types';
import { ChainMap } from '../../types';

import {
  LiquidityLayerV2Factories,
  liquidityLayerV2Factories,
} from './contracts';

export enum AdapterType {
  CCTP = 'CCTP',
}

export type CctpAdapterConfig = RouterConfig & {
  type: AdapterType.CCTP;
  tokenMessengerAddress: string;
  token: string;
  tokenSymbol: string;
  gasAmount: number;
  circleDomainMapping: {
    hyperlaneDomain: number;
    circleDomain: number;
  }[];
};

export class CctpAdapterDeployer extends ProxiedRouterDeployer<
  CctpAdapterConfig,
  LiquidityLayerV2Factories,
  'CctpAdapter'
> {
  readonly routerContractName = 'CctpAdapter';

  constructor(multiProvider: MultiProvider) {
    super(multiProvider, liquidityLayerV2Factories);
  }

  async constructorArgs(_: string, __: CctpAdapterConfig): Promise<[]> {
    return [];
  }

  async initializeArgs(
    chain: string,
    config: CctpAdapterConfig,
  ): Promise<
    [
      _owner: string,
      _tokenMessengerAddress: string,
      _token: string,
      _tokenSymbol: string,
      _gasAmount: number,
      _mailbox: string,
      _interchainGasPaymaster: string,
      _interchainSecurityModule: string,
    ]
  > {
    const owner = await this.multiProvider.getSignerAddress(chain);
    return [
      owner,
      config.tokenMessengerAddress,
      config.token,
      config.tokenSymbol,
      config.gasAmount,
      config.mailbox,
      config.interchainGasPaymaster,
      config.interchainSecurityModule ?? ethers.constants.AddressZero,
    ];
  }

  async enrollRemoteRouters(
    contractsMap: HyperlaneContractsMap<LiquidityLayerV2Factories>,
    configMap: ChainMap<CctpAdapterConfig>,
  ): Promise<void> {
    this.logger(`Enroll CCTP adapters with each other`);
    await super.enrollRemoteRouters(contractsMap, configMap);
  }

  async deployContracts(
    chain: string,
    config: CctpAdapterConfig,
  ): Promise<
    HyperlaneContracts<{
      proxyAdmin: ProxyAdmin__factory;
      CctpAdapter: CctpAdapter__factory;
    }>
  > {
    const cctpAdapterFactory = await super.deployContracts(chain, config);
    const cctpAdapter = cctpAdapterFactory.CctpAdapter;

    // Set domain mappings
    for (const {
      circleDomain,
      hyperlaneDomain,
    } of config.circleDomainMapping) {
      const expectedCircleDomain =
        await cctpAdapter.hyperlaneDomainToCircleDomain(hyperlaneDomain);
      if (expectedCircleDomain === circleDomain) continue;

      this.logger(
        `Set circle domain ${circleDomain} for hyperlane domain ${hyperlaneDomain}`,
      );
      await this.runIfOwner(chain, cctpAdapter, () =>
        this.multiProvider.handleTx(
          chain,
          cctpAdapter.addDomain(hyperlaneDomain, circleDomain),
        ),
      );
    }

    return cctpAdapterFactory;
  }
}
