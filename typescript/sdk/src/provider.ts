import { ethers } from 'ethers';
import { ChainName, ChainSubsetMap } from './types';
import { MultiGeneric } from './utils';

export class DomainConnection {
  provider?: ethers.providers.BaseProvider;
  signer?: ethers.Signer;

  constructor(
    rpc?: string,
    public overrides: ethers.Overrides = {},
    public confirmations: number = 0,
  ) {
    if (rpc) {
      this.registerRpcURL(rpc);
    }
  }

  registerOverrides = (overrides: ethers.Overrides) => this.overrides = overrides;

  registerConfirmations = (confirmations: number) => this.confirmations = confirmations;

  registerProvider = (provider: ethers.providers.BaseProvider) =>
    (this.provider = provider);

  registerRpcURL = (url: string) =>
    this.registerProvider(new ethers.providers.JsonRpcProvider(url));

  registerSigner = (signer: ethers.Signer) =>
    (this.signer = signer.connect(this.provider!));

  registerWalletSigner = (privatekey: string) =>
    this.registerSigner(new ethers.Wallet(privatekey));

  getConnection = () => this.signer ?? this.provider;

  getAddress = () => this.signer?.getAddress();
}

export class MultiProvider<
  Networks extends ChainName = ChainName,
> extends MultiGeneric<DomainConnection, Networks> {
  constructor(networkRpcUrls: ChainSubsetMap<Networks, string>) {
    const providerEntries = Object.entries<string>(networkRpcUrls).map(
      ([network, v]) => [network, new DomainConnection(v)],
    );
    super(Object.fromEntries(providerEntries));
  }
  getDomainConnection(network: Networks) {
    return this.get(network);
  }
  getChains(chains: Networks[]) {
    return this.entries().filter(([chain]) => chains.includes(chain));
  }
  getAll() {
    return this.values();
  }
  ready() {
    return Promise.all(this.values().map((dc) => dc.provider!.ready));
  }
}
