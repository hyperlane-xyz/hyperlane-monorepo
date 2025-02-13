import { BigNumber } from 'ethers';
import { CairoOption, CairoOptionVariant, Call, Contract } from 'starknet';

import { Address, Domain, Numberish } from '@hyperlane-xyz/utils';

import { BaseStarknetAdapter } from '../../app/MultiProtocolApp.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { ChainName } from '../../types.js';
import { getStarknetHypERC20Contract } from '../../utils/starknet.js';
import { TokenMetadata } from '../types.js';

import {
  IHypTokenAdapter,
  InterchainGasQuote,
  TransferParams,
  TransferRemoteParams,
} from './ITokenAdapter.js';

const ETH_ADDRESS =
  '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7';

export class StarknetNativeTokenAdapter extends BaseStarknetAdapter {
  async getBalance(address: Address): Promise<bigint> {
    // On starknet, native tokens are ERC20s
    const tokenContract = await this.getERC20Contract(ETH_ADDRESS);
    const res = await tokenContract.balanceOf(address);
    return res;
  }

  async getMetadata(): Promise<TokenMetadata> {
    return {
      symbol: 'ETH',
      name: 'Ethereum',
      totalSupply: 0,
      decimals: 18,
    };
  }

  async getMinimumTransferAmount(_recipient: Address): Promise<bigint> {
    return 0n;
  }

  async isApproveRequired(
    owner: Address,
    spender: Address,
    weiAmountOrId: Numberish,
  ): Promise<boolean> {
    // Native tokens are ERC20s thus need to be approved
    const ethToken = await this.getERC20Contract(ETH_ADDRESS);

    const allowance = await ethToken.allowance(owner, spender);

    return BigNumber.from(allowance.toString()).lt(
      BigNumber.from(weiAmountOrId),
    );
  }

  async populateApproveTx({
    weiAmountOrId,
    recipient,
  }: TransferParams): Promise<Call> {
    // Native tokens are ERC20s thus need to be approved
    const ethToken = await this.getERC20Contract(ETH_ADDRESS);

    return ethToken.populateTransaction.approve(recipient, weiAmountOrId);
  }

  async populateTransferTx({
    weiAmountOrId,
    recipient,
  }: TransferParams): Promise<Call> {
    const tokenContract = await this.getERC20Contract(ETH_ADDRESS);
    return tokenContract.populateTransaction.transfer(recipient, weiAmountOrId);
  }

  async getTotalSupply(): Promise<bigint | undefined> {
    return undefined;
  }
}

export class StarknetHypNativeAdapter
  extends StarknetNativeTokenAdapter
  implements IHypTokenAdapter<Call>
{
  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { warpRouter: Address },
  ) {
    super(chainName, multiProvider, addresses);
  }

  async quoteTransferRemoteGas(
    _destination: Domain,
  ): Promise<InterchainGasQuote> {
    return { amount: BigInt(0) };
  }

  async populateTransferRemoteTx({
    weiAmountOrId,
    destination,
    recipient,
  }: TransferRemoteParams): Promise<Call> {
    const { abi } = await this.getProvider().getClassAt(
      this.addresses.warpRouter,
    );
    const warpRouter = new Contract(abi, this.addresses.warpRouter);

    const nonOption = new CairoOption(CairoOptionVariant.None);

    const transferTx = warpRouter.populateTransaction.transfer_remote(
      destination,
      recipient,
      BigInt('1'),
      BigInt('1'),
      nonOption,
      nonOption,
    );

    // TODO: add gas payment when we support it

    return transferTx;
  }

  async getDomains(): Promise<Domain[]> {
    return [];
  }

  async getRouterAddress(domain: Domain): Promise<Buffer> {
    return Buffer.from(ETH_ADDRESS);
  }

  async getAllRouters(): Promise<Array<{ domain: Domain; address: Buffer }>> {
    return [];
  }

  async getBridgedSupply(): Promise<bigint | undefined> {
    return undefined;
  }
}

export class StarknetHypSyntheticAdapter
  extends StarknetNativeTokenAdapter
  implements IHypTokenAdapter<Call>
{
  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { token: Address },
  ) {
    super(chainName, multiProvider, addresses);
  }

  override async getBalance(address: Address): Promise<bigint> {
    const tokenContract = await this.getERC20Contract(this.addresses.token);
    return tokenContract.balanceOf(address);
  }

  override async populateTransferTx({
    weiAmountOrId,
    recipient,
  }: TransferParams): Promise<Call> {
    const tokenContract = await this.getERC20Contract(this.addresses.token);
    return tokenContract.populateTransaction.transfer(recipient, weiAmountOrId);
  }

  async quoteTransferRemoteGas(
    _destination: Domain,
  ): Promise<InterchainGasQuote> {
    return { amount: BigInt(0) };
  }

  async populateTransferRemoteTx({
    weiAmountOrId,
    destination,
    recipient,
    interchainGas,
  }: TransferRemoteParams): Promise<Call> {
    const hypToken = getStarknetHypERC20Contract(this.addresses.token);
    const nonOption = new CairoOption(CairoOptionVariant.None);

    const transferTx = hypToken.populateTransaction.transfer_remote(
      destination,
      recipient,
      BigInt(weiAmountOrId.toString()),
      BigInt(0),
      nonOption,
      nonOption,
    );

    // TODO: add gas payment when we support it

    return {
      ...transferTx,
      value: interchainGas?.amount
        ? BigNumber.from(interchainGas.amount)
        : BigNumber.from(0),
    };
  }

  async getDomains(): Promise<Domain[]> {
    return [];
  }

  async getRouterAddress(domain: Domain): Promise<Buffer> {
    return Buffer.from(this.addresses.token);
  }

  async getAllRouters(): Promise<Array<{ domain: Domain; address: Buffer }>> {
    return [];
  }

  async getBridgedSupply(): Promise<bigint | undefined> {
    return undefined;
  }
}
