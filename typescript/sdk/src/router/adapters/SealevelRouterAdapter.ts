/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { PublicKey } from '@solana/web3.js';
import { deserializeUnchecked } from 'borsh';

import { Address, Domain } from '@hyperlane-xyz/utils';

import { BaseSealevelAdapter } from '../../app/MultiProtocolApp';
import { ChainName } from '../../types';
import { SealevelAccountDataWrapper } from '../../utils/sealevel';
import {
  SealevelHyperlaneTokenData,
  SealevelHyperlaneTokenDataSchema,
} from '../../utils/sealevel/tokenSerialization';
import { RouterAddress } from '../types';

import { IGasRouterAdapter, IRouterAdapter } from './types';

export class SealevelRouterAdapter<
    ContractAddrs extends RouterAddress = RouterAddress,
  >
  extends BaseSealevelAdapter<ContractAddrs>
  implements IRouterAdapter<ContractAddrs>
{
  async interchainSecurityModule(chain: ChainName): Promise<Address> {
    const routerAccountInfo = await this.getRouterAccountInfo(chain);
    if (!routerAccountInfo.interchain_security_module_pubkey)
      throw new Error(`No ism found for router on ${chain}`);
    return routerAccountInfo.interchain_security_module_pubkey.toBase58();
  }

  async owner(chain: ChainName): Promise<Address> {
    const routerAccountInfo = await this.getRouterAccountInfo(chain);
    if (!routerAccountInfo.owner_pub_key)
      throw new Error(`No owner found for router on ${chain}`);
    return routerAccountInfo.owner_pub_key.toBase58();
  }

  async remoteDomains(originChain: ChainName): Promise<Domain[]> {
    const routers = await this.remoteRouters(originChain);
    return routers.map((router) => router.domain);
  }

  async remoteRouter(
    originChain: ChainName,
    remoteDomain: Domain,
  ): Promise<Address> {
    const routers = await this.remoteRouters(originChain);
    const addr = routers.find(
      (router) => router.domain === remoteDomain,
    )?.address;
    if (!addr) throw new Error(`No router found for ${remoteDomain}`);
    return addr;
  }

  async remoteRouters(
    originChain: ChainName,
  ): Promise<Array<{ domain: Domain; address: Address }>> {
    const routerAccountInfo = await this.getRouterAccountInfo(originChain);
    const domainToPubKey = routerAccountInfo.remote_router_pubkeys;
    return Array.from(domainToPubKey.entries()).map(([domain, pubKey]) => ({
      domain,
      address: pubKey.toBase58(),
    }));
  }

  // TODO this incorrectly assumes all sealevel routers will have the TokenRouter's data schema
  // This will need to change when other types of routers are supported
  async getRouterAccountInfo(
    chain: ChainName,
  ): Promise<SealevelHyperlaneTokenData> {
    const address = this.multiProvider.getChainMetadata(chain).router;
    const connection = this.multiProvider.getSolanaWeb3Provider(chain);

    const msgRecipientPda = this.deriveMessageRecipientPda(address);
    const accountInfo = await connection.getAccountInfo(msgRecipientPda);
    if (!accountInfo)
      throw new Error(
        `No account info found for ${msgRecipientPda.toBase58()}}`,
      );
    const accountData = deserializeUnchecked(
      SealevelHyperlaneTokenDataSchema,
      SealevelAccountDataWrapper,
      accountInfo.data,
    );
    return accountData.data as SealevelHyperlaneTokenData;
  }

  // Should match https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/rust/sealevel/libraries/hyperlane-sealevel-token/src/processor.rs
  deriveMessageRecipientPda(routerAddress: Address | PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from('hyperlane_message_recipient'),
        Buffer.from('-'),
        Buffer.from('handle'),
        Buffer.from('-'),
        Buffer.from('account_metas'),
      ],
      new PublicKey(routerAddress),
    );
    return pda;
  }
}

export class SealevelGasRouterAdapter<
    ContractAddrs extends RouterAddress = RouterAddress,
  >
  extends SealevelRouterAdapter<ContractAddrs>
  implements IGasRouterAdapter<ContractAddrs>
{
  async quoteGasPayment(
    _origin: ChainName,
    _destination: ChainName,
  ): Promise<string> {
    throw new Error('Gas payments not yet supported for sealevel');
  }
}
