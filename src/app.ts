import { BigNumberish } from 'ethers';

import {
  ChainName,
  GasRouterApp,
  RouterContracts,
} from '@hyperlane-xyz/sdk';
import { types } from '@hyperlane-xyz/utils';

import { HypERC20Contracts, HypERC721Contracts } from './contracts';
import { TokenRouter } from './types';

class HyperlaneTokenApp<
  Contracts extends RouterContracts<TokenRouter>,
  Chain extends ChainName,
> extends GasRouterApp<Contracts, Chain> {
  async transfer<Origin extends Chain>(
    origin: Origin,
    destination: Exclude<Chain, Origin>,
    recipient: types.Address,
    amountOrId: BigNumberish,
  ) {
    const originRouter = this.getContracts(origin).router;
    const destinationChainConnection = this.multiProvider.getChainConnection(destination);
    const destinationNetwork = await destinationChainConnection.provider.getNetwork();
    const gasPayment = await originRouter.quoteGasPayment(destinationNetwork.chainId);
    const chainConnection = this.multiProvider.getChainConnection(origin);
    return chainConnection.handleTx(
      originRouter.transferRemote(destinationNetwork.chainId, recipient, amountOrId, {
        value: gasPayment,
      }),
    );
  }
}

export class HypERC20App<Chain extends ChainName> extends HyperlaneTokenApp<
  HypERC20Contracts,
  Chain
> {
  async transfer<Origin extends Chain>(
    origin: Origin,
    destination: Exclude<Chain, Origin>,
    recipient: types.Address,
    amount: BigNumberish,
  ) {
    const originRouter = this.getContracts(origin).router;
    const chainConnection = this.multiProvider.getChainConnection(origin);
    const signerAddress = await chainConnection.signer!.getAddress();
    const balance = await originRouter.balanceOf(signerAddress);
    if (balance.lt(amount))
      console.warn(
        `Signer ${signerAddress} has insufficient balance ${balance}, needs ${amount} on ${origin}`,
      );
    return super.transfer(origin, destination, recipient, amount);
  }
}

export class HypERC721App<Chain extends ChainName> extends HyperlaneTokenApp<
  HypERC721Contracts,
  Chain
> {
  async transfer<Origin extends Chain>(
    origin: Origin,
    destination: Exclude<Chain, Origin>,
    recipient: types.Address,
    tokenId: BigNumberish,
  ) {
    const originRouter = this.getContracts(origin).router;
    const chainConnection = this.multiProvider.getChainConnection(origin);
    const signerAddress = await chainConnection.signer!.getAddress();
    const owner = await originRouter.ownerOf(tokenId);
    if (signerAddress != owner)
      console.warn(`Signer ${signerAddress} not owner of token ${tokenId} on ${origin}`);
    return super.transfer(origin, destination, recipient, tokenId);
  }
}
