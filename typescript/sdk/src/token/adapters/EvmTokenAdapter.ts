import { BigNumber, PopulatedTransaction } from 'ethers';

import {
  ERC20,
  ERC20__factory,
  HypERC20,
  HypERC20Collateral__factory,
  HypERC20__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  Domain,
  addressToByteHexString,
  addressToBytes32,
  bytes32ToAddress,
  strip0x,
} from '@hyperlane-xyz/utils';

import { BaseEvmAdapter } from '../../app/MultiProtocolApp';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider';
import { ChainName } from '../../types';
import { MinimalTokenMetadata } from '../config';

import {
  IHypTokenAdapter,
  ITokenAdapter,
  TransferParams,
  TransferRemoteParams,
} from './ITokenAdapter';

// Interacts with native currencies
export class EvmNativeTokenAdapter
  extends BaseEvmAdapter
  implements ITokenAdapter
{
  async getBalance(address: Address): Promise<string> {
    const balance = await this.getProvider().getBalance(address);
    return balance.toString();
  }

  async getMetadata(): Promise<MinimalTokenMetadata> {
    // TODO get metadata from chainMetadata config
    throw new Error('Metadata not available to native tokens');
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
    const value = BigNumber.from(weiAmountOrId);
    return { value, to: recipient };
  }
}

// Interacts with ERC20/721 contracts
export class EvmTokenAdapter<T extends ERC20 = ERC20>
  extends EvmNativeTokenAdapter
  implements ITokenAdapter
{
  public readonly contract: T;

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { token: Address },
    public readonly contractFactory: any = ERC20__factory,
  ) {
    super(chainName, multiProvider, addresses);
    this.contract = contractFactory.connect(
      addresses.token,
      this.getProvider(),
    );
  }

  override async getBalance(address: Address): Promise<string> {
    const balance = await this.contract.balanceOf(address);
    return balance.toString();
  }

  override async getMetadata(isNft?: boolean): Promise<MinimalTokenMetadata> {
    const [decimals, symbol, name] = await Promise.all([
      isNft ? 0 : this.contract.decimals(),
      this.contract.symbol(),
      this.contract.name(),
    ]);
    return { decimals, symbol, name };
  }

  override populateApproveTx({
    weiAmountOrId,
    recipient,
  }: TransferParams): Promise<PopulatedTransaction> {
    return this.contract.populateTransaction.approve(recipient, weiAmountOrId);
  }

  override populateTransferTx({
    weiAmountOrId,
    recipient,
  }: TransferParams): Promise<PopulatedTransaction> {
    return this.contract.populateTransaction.transfer(recipient, weiAmountOrId);
  }
}

// Interacts with Hyp Synthetic token contracts (aka 'HypTokens')
export class EvmHypSyntheticAdapter<T extends HypERC20 = HypERC20>
  extends EvmTokenAdapter<T>
  implements IHypTokenAdapter
{
  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { token: Address },
    public readonly contractFactory: any = HypERC20__factory,
  ) {
    super(chainName, multiProvider, addresses, contractFactory);
  }

  getDomains(): Promise<Domain[]> {
    return this.contract.domains();
  }

  async getRouterAddress(domain: Domain): Promise<Buffer> {
    const routerAddressesAsBytes32 = await this.contract.routers(domain);
    // Evm addresses will be padded with 12 bytes
    if (routerAddressesAsBytes32.startsWith('0x000000000000000000000000')) {
      return Buffer.from(
        strip0x(bytes32ToAddress(routerAddressesAsBytes32)),
        'hex',
      );
      // Otherwise leave the address unchanged
    } else {
      return Buffer.from(strip0x(routerAddressesAsBytes32), 'hex');
    }
  }

  async getAllRouters(): Promise<Array<{ domain: Domain; address: Buffer }>> {
    const domains = await this.getDomains();
    const routers: Buffer[] = await Promise.all(
      domains.map((d) => this.getRouterAddress(d)),
    );
    return domains.map((d, i) => ({ domain: d, address: routers[i] }));
  }

  async quoteGasPayment(destination: Domain): Promise<string> {
    const gasPayment = await this.contract.quoteGasPayment(destination);
    return gasPayment.toString();
  }

  populateTransferRemoteTx({
    weiAmountOrId,
    destination,
    recipient,
    txValue,
  }: TransferRemoteParams): Promise<PopulatedTransaction> {
    const recipBytes32 = addressToBytes32(addressToByteHexString(recipient));
    return this.contract.populateTransaction.transferRemote(
      destination,
      recipBytes32,
      weiAmountOrId,
      {
        // Note, typically the value is the gas payment as quoted by IGP
        value: txValue,
      },
    );
  }
}

// Interacts with HypCollateral and HypNative contracts
export class EvmHypCollateralAdapter
  extends EvmHypSyntheticAdapter
  implements IHypTokenAdapter
{
  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { token: Address },
    public readonly contractFactory: any = HypERC20Collateral__factory,
  ) {
    super(chainName, multiProvider, addresses, contractFactory);
  }

  override getMetadata(): Promise<MinimalTokenMetadata> {
    // TODO pass through metadata from wrapped token or chainMetadata config
    throw new Error(
      'Metadata not available for HypCollateral/HypNative contract.',
    );
  }

  override populateApproveTx(
    _params: TransferParams,
  ): Promise<PopulatedTransaction> {
    throw new Error(
      'Approve not applicable to HypCollateral/HypNative contract.',
    );
  }

  override populateTransferTx(
    _params: TransferParams,
  ): Promise<PopulatedTransaction> {
    throw new Error(
      'Local transfer not supported for HypCollateral/HypNative contract.',
    );
  }
}
