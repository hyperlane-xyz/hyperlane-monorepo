import {
  ChainName,
  HyperlaneApp,
  objMap,
  promiseObjAll,
} from '@hyperlane-xyz/sdk';

import { HypERC20Contracts, HypERC721Contracts } from './contracts';

export class HypERC20App<Chain extends ChainName> extends HyperlaneApp<
  HypERC20Contracts,
  Chain
> {
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

// TODO: dedupe?
export class HypERC721App<Chain extends ChainName> extends HyperlaneApp<
  HypERC721Contracts,
  Chain
> {
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
