import type { BigNumber, ethers } from 'ethers';

import { GasRouter, Router } from '@hyperlane-xyz/core';
import type { types } from '@hyperlane-xyz/utils';

import { HyperlaneApp } from './HyperlaneApp';
import { HyperlaneContracts, HyperlaneFactories } from './contracts';
import { ChainNameToDomainId } from './domains';
import { ChainName } from './types';
import { objMap, promiseObjAll } from './utils/objects';

export type RouterContracts<RouterContract extends Router = Router> =
  HyperlaneContracts & {
    router: RouterContract;
  };

type RouterFactory<RouterContract extends Router = Router> =
  ethers.ContractFactory & {
    deploy: (...args: any[]) => Promise<RouterContract>;
  };

export type RouterFactories<RouterContract extends Router = Router> =
  HyperlaneFactories & {
    router: RouterFactory<RouterContract>;
  };

export type ConnectionClientConfig = {
  mailbox: types.Address;
  interchainGasPaymaster: types.Address;
  interchainSecurityModule?: types.Address;
};

export { Router } from '@hyperlane-xyz/core';

export class RouterApp<
  Contracts extends RouterContracts,
  Chain extends ChainName = ChainName,
> extends HyperlaneApp<Contracts, Chain> {
  getSecurityModules = () =>
    promiseObjAll(
      objMap(this.contractsMap, (_, contracts) =>
        contracts.router.interchainSecurityModule(),
      ),
    );

  getOwners = () =>
    promiseObjAll(
      objMap(this.contractsMap, (_, contracts) => contracts.router.owner()),
    );
}

export class GasRouterApp<
  Contracts extends RouterContracts<GasRouter>,
  Chain extends ChainName = ChainName,
> extends RouterApp<Contracts, Chain> {
  async quoteGasPayment<Origin extends Chain>(
    origin: Origin,
    destination: Exclude<Chain, Origin>,
  ): Promise<BigNumber> {
    return this.getContracts(origin).router.quoteGasPayment(
      ChainNameToDomainId[destination],
    );
  }
}
