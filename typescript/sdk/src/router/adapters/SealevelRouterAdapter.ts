/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { PublicKey } from '@solana/web3.js';
import { deserializeUnchecked } from 'borsh';

import { Address, Domain } from '@hyperlane-xyz/utils';

import { BaseSealevelAdapter } from '../../app/MultiProtocolApp';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider';
import { ChainName } from '../../types';
import { RouterAddress } from '../types';

import { IGasRouterAdapter, IRouterAdapter } from './types';

// Hyperlane Token Borsh Schema
export class SealevelAccountDataWrapper {
  initialized!: boolean;
  data!: SealevelTokenData;
  constructor(public readonly fields: any) {
    Object.assign(this, fields);
  }
}

// Should match https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/trevor/sealevel-validator-rebase/rust/sealevel/libraries/hyperlane-sealevel-token/src/accounts.rs#L21
export class SealevelTokenData {
  /// The bump seed for this PDA.
  bump!: number;
  /// The address of the mailbox contract.
  mailbox!: Uint8Array;
  mailbox_pubkey!: PublicKey;
  /// The Mailbox process authority specific to this program as the recipient.
  mailbox_process_authority!: Uint8Array;
  mailbox_process_authority_pubkey!: PublicKey;
  /// The dispatch authority PDA's bump seed.
  dispatch_authority_bump!: number;
  /// The decimals of the local token.
  decimals!: number;
  /// The decimals of the remote token.
  remote_decimals!: number;
  /// Access control owner.
  owner?: Uint8Array;
  owner_pub_key?: PublicKey;
  /// The interchain security module.
  interchain_security_module?: Uint8Array;
  interchain_security_module_pubkey?: PublicKey;
  /// Remote routers.
  remote_routers?: Map<Domain, Uint8Array>;
  remote_router_pubkeys: Map<Domain, PublicKey>;
  constructor(public readonly fields: any) {
    Object.assign(this, fields);
    this.mailbox_pubkey = new PublicKey(this.mailbox);
    this.mailbox_pubkey = new PublicKey(this.mailbox_process_authority);
    this.owner_pub_key = this.owner ? new PublicKey(this.owner) : undefined;
    this.interchain_security_module_pubkey = this.interchain_security_module
      ? new PublicKey(this.interchain_security_module)
      : undefined;
    this.remote_router_pubkeys = new Map<number, PublicKey>();
    if (this.remote_routers) {
      for (const [k, v] of this.remote_routers.entries()) {
        this.remote_router_pubkeys.set(k, new PublicKey(v));
      }
    }
  }
}

export const SealevelTokenDataSchema = new Map<any, any>([
  [
    SealevelAccountDataWrapper,
    {
      kind: 'struct',
      fields: [
        ['initialized', 'u8'],
        ['data', SealevelTokenData],
      ],
    },
  ],
  [
    SealevelTokenData,
    {
      kind: 'struct',
      fields: [
        ['bump', 'u8'],
        ['mailbox', [32]],
        ['mailbox_process_authority', [32]],
        ['dispatch_authority_bump', 'u8'],
        ['decimals', 'u8'],
        ['remote_decimals', 'u8'],
        ['owner', { kind: 'option', type: [32] }],
        ['interchain_security_module', { kind: 'option', type: [32] }],
        ['remote_routers', { kind: 'map', key: 'u32', value: [32] }],
      ],
    },
  ],
]);

export class SealevelRouterAdapter<
    ContractAddrs extends RouterAddress = RouterAddress,
  >
  extends BaseSealevelAdapter<ContractAddrs>
  implements IRouterAdapter<ContractAddrs>
{
  constructor(
    public readonly multiProvider: MultiProtocolProvider<ContractAddrs>,
  ) {
    super(multiProvider);
  }

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
  async getRouterAccountInfo(chain: ChainName): Promise<SealevelTokenData> {
    const address = this.multiProvider.getChainMetadata(chain).router;
    const connection = this.multiProvider.getSolanaWeb3Provider(chain);

    const msgRecipientPda = this.deriveMessageRecipientPda(address);
    const accountInfo = await connection.getAccountInfo(msgRecipientPda);
    if (!accountInfo)
      throw new Error(
        `No account info found for ${msgRecipientPda.toBase58()}}`,
      );
    const accountData = deserializeUnchecked(
      SealevelTokenDataSchema,
      SealevelAccountDataWrapper,
      accountInfo.data,
    );
    return accountData.data;
  }

  // Should match https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/trevor/sealevel-validator-rebase/rust/sealevel/libraries/hyperlane-sealevel-token/src/processor.rs#LL49C1-L53C30
  deriveMessageRecipientPda(routerAddress: Address): PublicKey {
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
