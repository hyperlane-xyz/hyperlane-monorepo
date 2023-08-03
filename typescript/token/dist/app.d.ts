import { BigNumberish } from 'ethers';

import { ChainName, HyperlaneContracts, RouterApp } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import {
  HypERC20Factories,
  HypERC721Factories,
  TokenFactories,
} from './contracts';
import { TokenRouter } from './types';

declare class HyperlaneTokenApp<
  Factories extends TokenFactories,
> extends RouterApp<Factories> {
  router(contracts: HyperlaneContracts<TokenFactories>): TokenRouter;
  transfer(
    origin: ChainName,
    destination: ChainName,
    recipient: Address,
    amountOrId: BigNumberish,
  ): Promise<import('ethers').ContractReceipt>;
}
export declare class HypERC20App extends HyperlaneTokenApp<HypERC20Factories> {
  transfer(
    origin: ChainName,
    destination: ChainName,
    recipient: Address,
    amount: BigNumberish,
  ): Promise<import('ethers').ContractReceipt>;
}
export declare class HypERC721App extends HyperlaneTokenApp<HypERC721Factories> {
  transfer(
    origin: ChainName,
    destination: ChainName,
    recipient: Address,
    tokenId: BigNumberish,
  ): Promise<import('ethers').ContractReceipt>;
}
export {};
//# sourceMappingURL=app.d.ts.map
