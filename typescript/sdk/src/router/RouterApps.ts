import debug from 'debug';
import type { BigNumber } from 'ethers';

import { GasRouter, Router } from '@hyperlane-xyz/core';
import {
  Address,
  ProtocolType,
  objMap,
  promiseObjAll,
} from '@hyperlane-xyz/utils';

import { HyperlaneApp } from '../app/HyperlaneApp';
import {
  HyperlaneContracts,
  HyperlaneContractsMap,
  HyperlaneFactories,
} from '../contracts/types';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, ChainName } from '../types';

export { Router } from '@hyperlane-xyz/core';

export abstract class RouterApp<
  Factories extends HyperlaneFactories,
> extends HyperlaneApp<Factories> {
  constructor(
    contractsMap: HyperlaneContractsMap<Factories>,
    multiProvider: MultiProvider,
    logger?: debug.Debugger,
    readonly foreignDeployments: ChainMap<Address> = {},
  ) {
    super(contractsMap, multiProvider, logger);
  }

  abstract router(contracts: HyperlaneContracts<Factories>): Router;

  routerAddress(chainName: string): Address {
    if (
      this.multiProvider.getChainMetadata(chainName).protocol ===
      ProtocolType.Ethereum
    ) {
      return this.router(this.contractsMap[chainName])?.address;
    }
    return this.foreignDeployments[chainName];
  }

  override remoteChains(chainName: string): string[] {
    const chains = [
      ...super.remoteChains(chainName),
      ...Object.keys(this.foreignDeployments),
    ].filter(
      (chain) =>
        chain !== chainName &&
        this.multiProvider.tryGetChainMetadata(chain) !== null,
    );
    // for (chainName of chains) {
    //   // console.log('RouterApp remoteChains', router.domains());
    //   console.log(
    //     'RouterApp remoteChains1',
    //     this.multiProvider.tryGetChainMetadata(chainName),
    //   );
    // }
    return chains;
  }

  async remoteChainsAgain(chainName: string): Promise<string[]> {
    const router = this.router(this.contractsMap[chainName]);
    const domains = (await router.domains())
      .map((domain) => this.multiProvider.tryGetChainName(domain))
      .filter((domain): domain is string => domain !== null);
    console.log('RouterApp remoteChainsAgain', domains);
    return domains;
  }

  getSecurityModules(): Promise<ChainMap<Address>> {
    return promiseObjAll(
      objMap(this.chainMap, (_, contracts) =>
        this.router(contracts).interchainSecurityModule(),
      ),
    );
  }

  getOwners(): Promise<ChainMap<Address>> {
    return promiseObjAll(
      objMap(this.chainMap, (_, contracts) => this.router(contracts).owner()),
    );
  }
}

export abstract class GasRouterApp<
  Factories extends HyperlaneFactories,
  R extends GasRouter,
> extends RouterApp<Factories> {
  abstract router(contracts: HyperlaneContracts<Factories>): R;

  async quoteGasPayment(
    origin: ChainName,
    destination: ChainName,
  ): Promise<BigNumber> {
    return this.getContracts(origin).router.quoteGasPayment(
      this.multiProvider.getDomainId(destination),
    );
  }
}
