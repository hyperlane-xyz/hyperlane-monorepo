import { BigNumber, PopulatedTransaction } from 'ethers';
import { CairoOption, CairoOptionVariant, Contract } from 'starknet';

import {
  Address,
  Domain,
  Numberish, // bytes32ToAddress,
  // strip0x,
} from '@hyperlane-xyz/utils';

import { BaseStarknetAdapter } from '../../app/MultiProtocolApp.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { ChainName } from '../../types.js';
import { TokenMetadata } from '../types.js';

import {
  InterchainGasQuote,
  TransferParams,
  TransferRemoteParams,
} from './ITokenAdapter.js';

export class StarknetNativeTokenAdapter extends BaseStarknetAdapter {
  async getBalance(address: Address): Promise<bigint> {
    // ETH ABI - we only need the balanceOf function
    const ethContract = new Contract(
      [
        {
          name: 'balanceOf',
          type: 'function',
          inputs: [{ name: 'account', type: 'felt' }],
          outputs: [{ name: 'balance', type: 'Uint256' }],
          stateMutability: 'view',
        },
      ],
      '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7',
      this.getProvider(),
    );

    // Call balanceOf function
    const { balance } = await ethContract.balanceOf(address);

    return balance;
  }

  async getMetadata(): Promise<TokenMetadata> {
    // TODO get metadata from chainMetadata config
    throw new Error('Metadata not available to native tokens');
  }

  async getMinimumTransferAmount(_recipient: Address): Promise<bigint> {
    return 0n;
  }

  async isApproveRequired(
    _owner: Address,
    _spender: Address,
    _weiAmountOrId: Numberish,
  ): Promise<boolean> {
    return false;
  }

  async populateApproveTx(
    _params: TransferParams,
  ): Promise<PopulatedTransaction> {
    throw new Error('Approve not required for native tokens');
  }

  async populateTransferTx({
    weiAmountOrId,
    recipient,
  }: TransferParams): Promise<PopulatedTransaction> {
    const value = BigNumber.from(weiAmountOrId.toString());
    return { value, to: recipient };
  }

  async getTotalSupply(): Promise<bigint | undefined> {
    // Not implemented, native tokens don't have an accessible total supply
    return undefined;
  }
}

export class StarknetTokenAdapter extends StarknetNativeTokenAdapter {
  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: Record<string, Address>,
    public readonly denom: string,
  ) {
    super(chainName, multiProvider, addresses);
  }

  override async isApproveRequired(
    _owner: Address,
    _spender: Address,
    _weiAmountOrId: Numberish,
  ): Promise<boolean> {
    return false;
  }

  async quoteTransferRemoteGas(
    destination: Domain,
  ): Promise<InterchainGasQuote> {
    return { amount: BigInt(0) };
  }

  async populateTransferRemoteTx({
    weiAmountOrId,
    destination,
    recipient,
    interchainGas,
  }: TransferRemoteParams): Promise<PopulatedTransaction> {
    return { value: BigNumber.from(0) };
  }
}

export class StarknetHypSyntheticAdapter extends StarknetTokenAdapter {
  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { token: Address },
    public readonly denom: string,
  ) {
    super(chainName, multiProvider, addresses, denom);
  }

  override async isApproveRequired(
    _owner: Address,
    _spender: Address,
    _weiAmountOrId: Numberish,
  ): Promise<boolean> {
    return false;
  }

  async getDomains(): Promise<Domain[]> {
    return [11155111];
  }

  async getRouterAddress(_domain: Domain): Promise<Buffer> {
    const routerAddressesAsBytes32 =
      '0x00000000000000000000000059CeC7D4f6B56e35819F887Bb9D8cC0981eDa1E4';
    return Buffer.from(routerAddressesAsBytes32, 'hex');
    // Evm addresses will be padded with 12 bytes
    // if (routerAddressesAsBytes32.startsWith('0x000000000000000000000000')) {
    //   return Buffer.from(
    //     strip0x(bytes32ToAddress(routerAddressesAsBytes32)),
    //     'hex',
    //   );
    //   // Otherwise leave the address unchanged
    // } else {
    //   return Buffer.from(strip0x(routerAddressesAsBytes32), 'hex');
    // }
  }

  async getAllRouters(): Promise<Array<{ domain: Domain; address: Buffer }>> {
    const domains = await this.getDomains();
    const routers: Buffer[] = await Promise.all(
      domains.map((d) => this.getRouterAddress(d)),
    );
    return domains.map((d, i) => ({ domain: d, address: routers[i] }));
  }

  getBridgedSupply(): Promise<bigint | undefined> {
    return this.getTotalSupply();
  }

  async quoteTransferRemoteGas(
    _destination: Domain,
  ): Promise<InterchainGasQuote> {
    // const gasPayment = await this.contract.quoteGasPayment(destination);
    const gasPayment = BigInt(1);
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
    const { abi } = await this.getProvider().getClassAt(this.addresses.token);
    const tokenContract = new Contract(
      abi,
      '0x00000000000000000000000059CeC7D4f6B56e35819F887Bb9D8cC0981eDa1E4',
      this.getProvider(),
    );
    const nonOption = new CairoOption(CairoOptionVariant.None);
    return tokenContract.populateTransaction.transfer_remote(
      destination,
      recipient,
      BigInt(weiAmountOrId),
      BigInt(0),
      nonOption,
      nonOption,
    );
  }
}
