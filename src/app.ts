import { BigNumberish } from 'ethers';

import { ChainName, GasRouterApp, RouterContracts } from '@hyperlane-xyz/sdk';
import { types } from '@hyperlane-xyz/utils';

import { HypERC20Contracts, HypERC721Contracts } from './contracts';
import { TokenRouter } from './types';

class HyperlaneTokenApp<
  Contracts extends RouterContracts<TokenRouter>,
> extends GasRouterApp<Contracts> {
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

export class HypERC20App extends HyperlaneTokenApp<HypERC20Contracts> {
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

export class HypERC721App extends HyperlaneTokenApp<HypERC721Contracts> {
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
