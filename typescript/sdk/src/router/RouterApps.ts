import type { BigNumber } from 'ethers';
import { type Logger } from 'pino';

import { type GasRouter, type Router } from '@hyperlane-xyz/core';
import {
  type Address,
  ProtocolType,
  objMap,
  promiseObjAll,
} from '@hyperlane-xyz/utils';

import { HyperlaneApp } from '../app/HyperlaneApp.js';
import {
  type HyperlaneContracts,
  type HyperlaneContractsMap,
  type HyperlaneFactories,
} from '../contracts/types.js';
import { type MultiProvider } from '../providers/MultiProvider.js';
import { type ChainMap, type ChainName } from '../types.js';

export abstract class RouterApp<
  Factories extends HyperlaneFactories,
> extends HyperlaneApp<Factories> {
  constructor(
    contractsMap: HyperlaneContractsMap<Factories>,
    multiProvider: MultiProvider,
    logger?: Logger,
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
      return this.router(this.contractsMap[chainName]).address;
    }
    return this.foreignDeployments[chainName];
  }

  // check onchain for remote enrollments
  override async remoteChains(chainName: string): Promise<ChainName[]> {
    const router = this.router(this.contractsMap[chainName]);
    const onchainRemoteChainNames = (await router.domains()).map((domain) => {
      const chainName = this.multiProvider.tryGetChainName(domain);
      if (chainName === null) {
        throw new Error(`Chain name not found for domain: ${domain}`);
      }
      return chainName;
    });
    return onchainRemoteChainNames;
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
