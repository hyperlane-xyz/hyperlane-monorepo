import { BigNumberish } from 'ethers';

import { ChainName, HyperlaneContracts, RouterApp } from '@hyperlane-xyz/sdk';
import { types } from '@hyperlane-xyz/utils';

import {
  HypERC20Factories,
  HypERC721Factories,
  TokenFactories,
} from './contracts';
import { TokenRouter } from './types';

class HyperlaneTokenApp<
  Factories extends TokenFactories,
> extends RouterApp<Factories> {
  router(contracts: HyperlaneContracts<TokenFactories>): TokenRouter {
    return contracts.router;
  }

  async transfer(
    origin: ChainName,
    destination: ChainName,
    recipient: types.Address,
    amountOrId: BigNumberish,
  ) {
    const originRouter = this.getContracts(origin).router;
    const destProvider = this.multiProvider.getProvider(destination);
    const destinationNetwork = await destProvider.getNetwork();
    const gasPayment = await originRouter.quoteGasPayment(
      destinationNetwork.chainId,
    );
    return this.multiProvider.handleTx(
      origin,
      originRouter.transferRemote(
        destinationNetwork.chainId,
        recipient,
        amountOrId,
        {
          value: gasPayment,
        },
      ),
    );
  }
}

export class HypERC20App extends HyperlaneTokenApp<HypERC20Factories> {
  async transfer(
    origin: ChainName,
    destination: ChainName,
    recipient: types.Address,
    amount: BigNumberish,
  ) {
    const originRouter = this.getContracts(origin).router;
    const signerAddress = await this.multiProvider.getSignerAddress(origin);
    const balance = await originRouter.balanceOf(signerAddress);
    if (balance.lt(amount))
      console.warn(
        `Signer ${signerAddress} has insufficient balance ${balance}, needs ${amount} on ${origin}`,
      );
    return super.transfer(origin, destination, recipient, amount);
  }
}

export class HypERC721App extends HyperlaneTokenApp<HypERC721Factories> {
  async transfer(
    origin: ChainName,
    destination: ChainName,
    recipient: types.Address,
    tokenId: BigNumberish,
  ) {
    const originRouter = this.getContracts(origin).router;
    const signerAddress = await this.multiProvider.getSignerAddress(origin);
    const owner = await originRouter.ownerOf(tokenId);
    if (signerAddress != owner)
      console.warn(
        `Signer ${signerAddress} not owner of token ${tokenId} on ${origin}`,
      );
    return super.transfer(origin, destination, recipient, tokenId);
  }
}
