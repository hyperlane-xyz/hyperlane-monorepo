import { PopulatedTransaction } from '@ethersproject/contracts';
import { BigNumberish, ethers } from 'ethers';

import {
  ERC721,
  ERC721__factory,
  HypERC721Collateral,
  HypERC721Collateral__factory,
} from '@hyperlane-xyz/core';
import type {
  InterchainGasQuote,
  Token,
  TransferRemoteParams,
} from '@hyperlane-xyz/sdk';
import {
  EvmHypSyntheticAdapter,
  EvmTokenAdapter,
  IHypTokenAdapter,
  MultiProtocolProvider,
  TransferParams,
} from '@hyperlane-xyz/sdk';

// Interacts with HypCollateral contracts
export class EvmERC721CollateralAdapter
  extends EvmHypSyntheticAdapter
  implements IHypTokenAdapter<PopulatedTransaction>
{
  public readonly collateralContract: HypERC721Collateral;
  public readonly tokenAdapter: EvmERC721TokenAdapter;

  constructor(
    public readonly chainName: string,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly token: Token,
  ) {
    super(chainName, multiProvider, {
      token: token.collateralAddressOrDenom || token.addressOrDenom,
    });
    this.collateralContract = HypERC721Collateral__factory.connect(
      token.addressOrDenom,
      this.getProvider(),
    );
    this.tokenAdapter = new EvmERC721TokenAdapter(
      this.chainName,
      this.multiProvider,
      {
        token: token.collateralAddressOrDenom || token.addressOrDenom,
      },
    );
  }

  override getBridgedSupply(): Promise<bigint | undefined> {
    return this.getBalance(this.addresses.token);
  }

  override getMetadata(
    isNft?: boolean,
  ): ReturnType<EvmERC721TokenAdapter['getMetadata']> {
    return this.tokenAdapter.getMetadata(isNft);
  }

  override async isApproveRequired(
    owner: string,
    spender: string,
    weiAmountOrId: BigNumberish,
  ): Promise<boolean> {
    return this.tokenAdapter.isApproveRequired(owner, spender, weiAmountOrId);
  }

  override populateApproveTx(
    params: TransferParams,
  ): Promise<PopulatedTransaction> {
    return this.tokenAdapter.populateApproveTx(params);
  }

  override populateTransferTx(
    params: TransferParams,
  ): Promise<PopulatedTransaction> {
    return this.tokenAdapter.populateTransferTx(params);
  }

  override async quoteTransferRemoteGas(
    destination: number,
  ): Promise<InterchainGasQuote> {
    const gasPayment = await this.collateralContract.quoteGasPayment(
      destination,
    );
    // If EVM hyp contracts eventually support alternative IGP tokens,
    // this would need to determine the correct token address
    return { amount: BigInt(gasPayment.toString()) };
  }

  async populateTransferRemoteTx({
    weiAmountOrId,
    destination,
    recipient,
    interchainGas,
  }: TransferRemoteParams): Promise<PopulatedTransaction> {
    if (!interchainGas) {
      interchainGas = await this.quoteTransferRemoteGas(destination);
    }

    const recipBytes32 = ethers.zeroPadValue(recipient, 32);

    return this.collateralContract.populateTransaction[
      'transferRemote(uint32,bytes32,uint256)'
    ](destination, recipBytes32, weiAmountOrId, {
      value: interchainGas.amount.toString(),
    });
  }
}

export class EvmERC721TokenAdapter extends EvmTokenAdapter {
  contractERC721: ERC721;

  constructor(
    chainName: string,
    multiProvider: MultiProtocolProvider,
    addresses: { token: string },
  ) {
    super(chainName, multiProvider, addresses, ERC721__factory);
    this.contractERC721 = ERC721__factory.connect(
      addresses.token,
      this.getProvider(),
    );
  }

  override async getBalance(address: string): Promise<bigint> {
    const balance = await this.contractERC721.balanceOf(address);
    return BigInt(balance.toString());
  }

  override async isApproveRequired(
    owner: string,
    spender: string,
  ): Promise<boolean> {
    const isApprovedForAll = await this.contractERC721.isApprovedForAll(
      owner,
      spender,
    );

    return !isApprovedForAll;
  }

  override async populateApproveTx({
    recipient,
  }: TransferParams): Promise<PopulatedTransaction> {
    return this.contractERC721.populateTransaction[
      'setApprovalForAll(address,bool)'
    ](recipient, true);
  }

  async getTotalSupply(): Promise<bigint> {
    const totalSupply = await this.contractERC721.totalSupply();
    return totalSupply.toBigInt();
  }
}
