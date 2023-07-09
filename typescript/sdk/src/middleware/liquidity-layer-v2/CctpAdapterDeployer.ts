import { ethers } from 'ethers';

import { utils } from '@hyperlane-xyz/utils';

import { CCTPAdapter } from '../../../../../solidity/dist';
import { HyperlaneContracts, HyperlaneContractsMap } from '../../contracts';
import { MultiProvider } from '../../providers/MultiProvider';
import { ProxiedRouterDeployer } from '../../router/ProxiedRouterDeployer';
import { RouterConfig } from '../../router/types';
import { ChainMap, ChainName } from '../../types';
import { objFilter, objMap } from '../../utils/objects';

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
  usdcAddress: string;
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
  'CCTPAdapter'
> {
  readonly routerContractName = 'CCTPAdapter';

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
    chain: ChainName,
    config: CctpAdapterConfig,
  ): Promise<HyperlaneContracts<LiquidityLayerV2Factories>> {
    // This is just the temp owner for contracts, and HyperlaneRouterDeployer#transferOwnership actually sets the configured owner
    const deployer = await this.multiProvider.getSignerAddress(chain);

    const routerContracts = await super.deployContracts(chain, config);

    const bridgeAdapters: Partial<
      HyperlaneContracts<typeof liquidityLayerV2Factories>
    > = {};

    bridgeAdapters.CCTPAdapter = await this.deployCctpAdapter(
      chain,
      config,
      deployer,
    );

    return {
      ...routerContracts,
      ...bridgeAdapters,
    };
  }

  async deployCctpAdapter(
    chain: ChainName,
    adapterConfig: CctpAdapterConfig,
    owner: string,
  ): Promise<CCTPAdapter> {
    const cctpAdapter = await this.deployContract(
      chain,
      'CCTPAdapter',
      [],
      [
        owner,
        adapterConfig.tokenMessengerAddress,
        adapterConfig.token,
        adapterConfig.tokenSymbol,
        adapterConfig.gasAmount,
        adapterConfig.mailbox,
        adapterConfig.interchainGasPaymaster,
        adapterConfig.interchainSecurityModule ?? ethers.constants.AddressZero,
      ],
    );

    // Set domain mappings
    for (const {
      circleDomain,
      hyperlaneDomain,
    } of adapterConfig.circleDomainMapping) {
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

    return cctpAdapter;
  }
}
