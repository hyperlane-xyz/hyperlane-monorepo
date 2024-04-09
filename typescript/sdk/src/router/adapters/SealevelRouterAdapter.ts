import { PublicKey } from '@solana/web3.js';

import { Address, Domain } from '@hyperlane-xyz/utils';

import { BaseSealevelAdapter } from '../../app/MultiProtocolApp.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { ChainName } from '../../types.js';

import { IGasRouterAdapter, IRouterAdapter } from './types.js';

export class SealevelRouterAdapter
  extends BaseSealevelAdapter
  implements IRouterAdapter
{
  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider<any>,
    public readonly addresses: { router: Address },
  ) {
    super(chainName, multiProvider, addresses);
  }

  async interchainSecurityModule(): Promise<Address> {
    const routerAccountInfo = await this.getRouterAccountInfo();
    if (!routerAccountInfo.interchain_security_module_pubkey)
      throw new Error(`No ism found for router on ${this.chainName}`);
    return routerAccountInfo.interchain_security_module_pubkey.toBase58();
  }

  async owner(): Promise<Address> {
    const routerAccountInfo = await this.getRouterAccountInfo();
    if (!routerAccountInfo.owner_pub_key)
      throw new Error(`No owner found for router on ${this.chainName}`);
    return routerAccountInfo.owner_pub_key.toBase58();
  }

  async remoteDomains(): Promise<Domain[]> {
    const routers = await this.remoteRouters();
    return routers.map((router) => router.domain);
  }

  async remoteRouter(remoteDomain: Domain): Promise<Address> {
    const routers = await this.remoteRouters();
    const addr = routers.find(
      (router) => router.domain === remoteDomain,
    )?.address;
    if (!addr) throw new Error(`No router found for ${remoteDomain}`);
    return addr;
  }

  async remoteRouters(): Promise<Array<{ domain: Domain; address: Address }>> {
    const routerAccountInfo = await this.getRouterAccountInfo();
    const domainToPubKey = routerAccountInfo.remote_router_pubkeys;
    return Array.from(domainToPubKey.entries()).map(([domain, pubKey]) => ({
      domain,
      address: pubKey.toBase58(),
    }));
  }

  getRouterAccountInfo(): Promise<{
    owner_pub_key?: PublicKey;
    interchain_security_module?: Uint8Array;
    interchain_security_module_pubkey?: PublicKey;
    remote_router_pubkeys: Map<Domain, PublicKey>;
  }> {
    throw new Error('TODO getRouterAccountInfo not yet implemented');
  }

  // Should match https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/rust/sealevel/libraries/hyperlane-sealevel-token/src/processor.rs
  deriveMessageRecipientPda(routerAddress: Address | PublicKey): PublicKey {
    return super.derivePda(
      ['hyperlane_message_recipient', '-', 'handle', '-', 'account_metas'],
      routerAddress,
    );
  }
}

export class SealevelGasRouterAdapter
  extends SealevelRouterAdapter
  implements IGasRouterAdapter
{
  async quoteGasPayment(_destination: ChainName): Promise<string> {
    throw new Error('Gas payments not yet supported for sealevel');
  }
}
