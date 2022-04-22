import { ethers } from 'ethers';
import { ChainName, ChainSubsetMap } from './types';
import { MultiGeneric } from './utils';

export class DomainProvider {
  provider?: ethers.providers.Provider;
  signer?: ethers.Signer;

  constructor(rpc?: string) {
    if (rpc) {
      this.registerRpcURL(rpc);
    }
  }

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
  Networks extends ChainName = ChainName,
> extends MultiGeneric<DomainProvider, Networks> {
  constructor(domainMap: ChainSubsetMap<Networks, string>) {
    const providerEntries = Object.entries<string>(domainMap).map(
      ([network, v]) => [network, new DomainProvider(v)],
    );
    super(Object.fromEntries(providerEntries));
  }
  getProvider(network: Networks) {
    return this.get(network);
  }
}
