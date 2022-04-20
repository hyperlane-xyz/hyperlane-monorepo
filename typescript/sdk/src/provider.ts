import { ethers } from 'ethers';
import { ChainName } from './types';
import { MultiGeneric } from './utils';

export class DomainProvider {
  protected provider?: ethers.providers.Provider;
  protected signer?: ethers.Signer;

  constructor(
    protected overrides: ethers.Overrides = {},
    protected confirmations: number = 0,
  ) {}

  registerProvider = (provider: ethers.providers.Provider) =>
    (this.provider = provider);

  registerRpcURL = (url: string) =>
    this.registerProvider(new ethers.providers.StaticJsonRpcProvider(url));

  registerSigner = (signer: ethers.Signer) =>
    (this.signer = signer.connect(this.provider!));

  registerWalletSigner = (privatekey: string) =>
    this.registerSigner(new ethers.Wallet(privatekey));

  getConnection = () => this.signer ?? this.provider;

  getAddress = () => this.signer?.getAddress();
}

export class MultiProvider<
  Networks extends ChainName,
  Value,
> extends MultiGeneric<Networks, Value & DomainProvider> {}
