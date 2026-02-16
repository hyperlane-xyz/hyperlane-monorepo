import { PublicKey, Connection } from '@solana/web3.js';

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

  protected getConnection(): Connection {
    return this.multiProvider.getProvider(this.chainName) as Connection;
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

  async getRouterAccountInfo(): Promise<{
    owner_pub_key?: PublicKey;
    interchain_security_module?: Uint8Array;
    interchain_security_module_pubkey?: PublicKey;
    remote_router_pubkeys: Map<Domain, PublicKey>;
  }> {
    const connection = this.getConnection();
    const routerPubKey = new PublicKey(this.addresses.router);

    // Fetch the router account data
    const accountInfo = await connection.getAccountInfo(routerPubKey);
    if (!accountInfo) {
      throw new Error('Router account not found');
    }

    // Initialize empty map for remote router pubkeys
    const remote_router_pubkeys = new Map<Domain, PublicKey>();

    // Get all remote domains
    const domains = await this.remoteDomains();

    // Fetch remote router pubkeys for each domain
    for (const domain of domains) {
      const remoteRouterAddress = await this.remoteRouter(domain);
      remote_router_pubkeys.set(domain, new PublicKey(remoteRouterAddress));
    }

    // Get owner if available
    let owner_pub_key: PublicKey | undefined;
    try {
      const ownerAddress = await this.owner();
      owner_pub_key = new PublicKey(ownerAddress);
    } catch {
      // Owner is optional, so we can ignore errors
    }

    // Get ISM if available
    let interchain_security_module: Uint8Array | undefined;
    let interchain_security_module_pubkey: PublicKey | undefined;
    try {
      const ismAddress = await this.interchainSecurityModule();
      interchain_security_module_pubkey = new PublicKey(ismAddress);
      const ismAccountInfo = await connection.getAccountInfo(interchain_security_module_pubkey);
      if (ismAccountInfo) {
        interchain_security_module = ismAccountInfo.data;
      }
    } catch {
      // ISM is optional, so we can ignore errors
    }

    return {
      owner_pub_key,
      interchain_security_module,
      interchain_security_module_pubkey,
      remote_router_pubkeys,
    };
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
