import { encodeSecp256k1Pubkey } from '@cosmjs/amino';
import { Uint53 } from '@cosmjs/math';
import { type EncodeObject, Registry } from '@cosmjs/proto-signing';
import {
  type BankExtension,
  type MsgSendEncodeObject,
  QueryClient,
  StargateClient,
  defaultRegistryTypes,
  setupBankExtension,
} from '@cosmjs/stargate';
import { type CometClient, connectComet } from '@cosmjs/tendermint-rpc';

import { type AltVM } from '@hyperlane-xyz/provider-sdk';
import { assert, strip0x } from '@hyperlane-xyz/utils';

import {
  getHookType,
  getIgpHookConfig,
  getMerkleTreeHookConfig,
} from '../hook/hook-query.js';
import { type MsgRemoteTransferEncodeObject } from '../hyperlane/warp/messages.js';
import {
  type CoreExtension,
  setupCoreExtension,
} from '../hyperlane/core/query.js';
import {
  type InterchainSecurityExtension,
  setupInterchainSecurityExtension,
} from '../hyperlane/interchain_security/query.js';
import {
  type PostDispatchExtension,
  setupPostDispatchExtension,
} from '../hyperlane/post_dispatch/query.js';
import {
  type WarpExtension,
  setupWarpExtension,
} from '../hyperlane/warp/query.js';
import {
  getIsmType,
  getMerkleRootMultisigIsmConfig,
  getMessageIdMultisigIsmConfig,
  getNoopIsmConfig,
  getRoutingIsmConfig,
} from '../ism/ism-query.js';
import { COSMOS_MODULE_MESSAGE_REGISTRY as R } from '../registry.js';
import { getWarpTokenType } from '../warp/warp-query.js';

export class CosmosNativeProvider implements AltVM.IProvider<EncodeObject> {
  private readonly query: QueryClient &
    BankExtension &
    WarpExtension &
    CoreExtension &
    InterchainSecurityExtension &
    PostDispatchExtension;
  private readonly registry: Registry;
  private readonly cometClient: CometClient;
  private readonly rpcUrls: string[];

  private static NULL_ADDRESS =
    '0x0000000000000000000000000000000000000000000000000000000000000000';

  static async connect(
    rpcUrls: string[],
    _chainId: string | number,
  ): Promise<CosmosNativeProvider> {
    assert(rpcUrls.length > 0, `got no rpcUrls`);

    const client = await connectComet(rpcUrls[0]);
    return new CosmosNativeProvider(client, rpcUrls);
  }

  protected constructor(cometClient: CometClient, rpcUrls: string[]) {
    this.query = QueryClient.withExtensions(
      cometClient,
      setupBankExtension,
      setupCoreExtension,
      setupInterchainSecurityExtension,
      setupPostDispatchExtension,
      setupWarpExtension,
    );

    this.registry = new Registry([...defaultRegistryTypes]);

    // register all the custom tx types
    Object.values(R).forEach(({ proto }) => {
      this.registry.register(proto.type, proto.converter);
    });

    this.cometClient = cometClient;
    this.rpcUrls = rpcUrls;
  }

  // ### QUERY BASE ###

  async isHealthy() {
    const status = await this.cometClient.status();
    return status.syncInfo.latestBlockHeight > 0;
  }

  getRpcUrls(): string[] {
    return this.rpcUrls;
  }

  async getHeight() {
    const status = await this.cometClient.status();
    return status.syncInfo.latestBlockHeight;
  }

  async getBalance(req: AltVM.ReqGetBalance): Promise<bigint> {
    assert(req.denom, `denom required by ${CosmosNativeProvider.name}`);

    const coin = await this.query.bank.balance(req.address, req.denom);
    return BigInt(coin.amount);
  }

  async getTotalSupply(req: AltVM.ReqGetTotalSupply): Promise<bigint> {
    assert(req.denom, `denom required by ${CosmosNativeProvider.name}`);

    const coin = await this.query.bank.supplyOf(req.denom);
    return BigInt(coin.amount);
  }

  async estimateTransactionFee(
    req: AltVM.ReqEstimateTransactionFee<EncodeObject>,
  ): Promise<AltVM.ResEstimateTransactionFee> {
    assert(
      req.estimatedGasPrice,
      `Cosmos Native requires a estimatedGasPrice to estimate the transaction fee`,
    );
    assert(
      req.senderAddress,
      `Cosmos Native requires a senderAddress to estimate the transaction fee`,
    );
    assert(
      req.senderPubKey,
      `Cosmos Native requires a sender public key to estimate the transaction fee`,
    );
    const stargateClient = await StargateClient.connect(this.rpcUrls[0]);

    const message = this.registry.encodeAsAny(req.transaction);
    const pubKey = encodeSecp256k1Pubkey(
      new Uint8Array(Buffer.from(strip0x(req.senderPubKey), 'hex')),
    );

    const queryClient = stargateClient['getQueryClient']();
    assert(queryClient, `queryClient could not be found on stargate client`);

    const { sequence } = await stargateClient.getSequence(req.senderAddress);
    const { gasInfo } = await queryClient.tx.simulate(
      [message],
      undefined,
      pubKey,
      sequence,
    );
    const gasUnits = Uint53.fromString(
      gasInfo?.gasUsed.toString() ?? '0',
    ).toNumber();

    const gasPrice = parseFloat(req.estimatedGasPrice.toString());
    return {
      gasUnits: BigInt(gasUnits),
      gasPrice,
      fee: BigInt(Math.floor(gasUnits * gasPrice)),
    };
  }

  // ### QUERY CORE ###

  async getMailbox(req: AltVM.ReqGetMailbox): Promise<AltVM.ResGetMailbox> {
    const { mailbox } = await this.query.core.Mailbox({
      id: req.mailboxAddress,
    });
    assert(mailbox, `found no mailbox for id ${req.mailboxAddress}`);

    if (mailbox.default_ism === CosmosNativeProvider.NULL_ADDRESS) {
      mailbox.default_ism = '';
    }

    return {
      address: mailbox.id,
      owner: mailbox.owner,
      localDomain: mailbox.local_domain,
      defaultIsm: mailbox.default_ism,
      defaultHook: mailbox.default_hook,
      requiredHook: mailbox.required_hook,
      nonce: mailbox.message_sent,
    };
  }

  async isMessageDelivered(req: AltVM.ReqIsMessageDelivered): Promise<boolean> {
    const { delivered } = await this.query.core.Delivered({
      id: req.mailboxAddress,
      message_id: req.messageId,
    });
    return delivered;
  }

  async getIsmType(req: AltVM.ReqGetIsmType): Promise<AltVM.IsmType> {
    return getIsmType(this.query, req.ismAddress);
  }

  async getMessageIdMultisigIsm(
    req: AltVM.ReqMessageIdMultisigIsm,
  ): Promise<AltVM.ResMessageIdMultisigIsm> {
    return getMessageIdMultisigIsmConfig(this.query, req.ismAddress);
  }

  async getMerkleRootMultisigIsm(
    req: AltVM.ReqMerkleRootMultisigIsm,
  ): Promise<AltVM.ResMerkleRootMultisigIsm> {
    return getMerkleRootMultisigIsmConfig(this.query, req.ismAddress);
  }

  async getRoutingIsm(req: AltVM.ReqRoutingIsm): Promise<AltVM.ResRoutingIsm> {
    return getRoutingIsmConfig(this.query, req.ismAddress);
  }

  async getNoopIsm(req: AltVM.ReqNoopIsm): Promise<AltVM.ResNoopIsm> {
    return getNoopIsmConfig(this.query, req.ismAddress);
  }

  async getHookType(req: AltVM.ReqGetHookType): Promise<AltVM.HookType> {
    return getHookType(this.query, req.hookAddress);
  }

  async getInterchainGasPaymasterHook(
    req: AltVM.ReqGetInterchainGasPaymasterHook,
  ): Promise<AltVM.ResGetInterchainGasPaymasterHook> {
    return getIgpHookConfig(this.query, req.hookAddress);
  }

  async getMerkleTreeHook(
    req: AltVM.ReqGetMerkleTreeHook,
  ): Promise<AltVM.ResGetMerkleTreeHook> {
    return getMerkleTreeHookConfig(this.query, req.hookAddress);
  }

  async getNoopHook(req: AltVM.ReqGetNoopHook): Promise<AltVM.ResGetNoopHook> {
    const { noop_hook } = await this.query.postDispatch.NoopHook({
      id: req.hookAddress,
    });
    assert(noop_hook, `found no noop hook for id ${req.hookAddress}`);

    return {
      address: noop_hook.id,
    };
  }

  // ### QUERY WARP ###

  async getToken(req: AltVM.ReqGetToken): Promise<AltVM.ResGetToken> {
    const { token } = await this.query.warp.Token({
      id: req.tokenAddress,
    });
    assert(token, `found no token for id ${req.tokenAddress}`);

    const token_type = await getWarpTokenType(this.query, req.tokenAddress);

    return {
      address: token.id,
      owner: token.owner,
      tokenType: token_type,
      mailboxAddress: token.origin_mailbox,
      ismAddress: token.ism_id,
      hookAddress: '',
      denom: token.origin_denom,
      name: '',
      symbol: '',
      decimals: 0,
    };
  }

  async getRemoteRouters(
    req: AltVM.ReqGetRemoteRouters,
  ): Promise<AltVM.ResGetRemoteRouters> {
    const { remote_routers } = await this.query.warp.RemoteRouters({
      id: req.tokenAddress,
    });

    return {
      address: req.tokenAddress,
      remoteRouters: remote_routers.map((r) => ({
        receiverDomainId: r.receiver_domain,
        receiverAddress: r.receiver_contract,
        gas: r.gas,
      })),
    };
  }

  async getBridgedSupply(req: AltVM.ReqGetBridgedSupply): Promise<bigint> {
    const { bridged_supply } = await this.query.warp.BridgedSupply({
      id: req.tokenAddress,
    });
    assert(
      bridged_supply,
      `found no bridged supply for token id ${req.tokenAddress}`,
    );

    return BigInt(bridged_supply.amount);
  }

  async quoteRemoteTransfer(
    req: AltVM.ReqQuoteRemoteTransfer,
  ): Promise<AltVM.ResQuoteRemoteTransfer> {
    const { gas_payment } = await this.query.warp.QuoteRemoteTransfer({
      id: req.tokenAddress,
      destination_domain: req.destinationDomainId.toString(),
      custom_hook_id: req.customHookAddress || '',
      custom_hook_metadata: req.customHookMetadata || '',
    });
    assert(
      gas_payment && gas_payment[0],
      `found no quote for token id ${req.tokenAddress} and destination domain ${req.destinationDomainId}`,
    );

    return {
      denom: gas_payment[0].denom,
      amount: BigInt(gas_payment[0].amount),
    };
  }

  async getTransferTransaction(
    req: AltVM.ReqTransfer,
  ): Promise<MsgSendEncodeObject> {
    assert(req.denom, `denom required by ${CosmosNativeProvider.name}`);

    return {
      typeUrl: '/cosmos.bank.v1beta1.MsgSend',
      value: {
        fromAddress: req.signer,
        toAddress: req.recipient,
        amount: [
          {
            denom: req.denom,
            amount: req.amount,
          },
        ],
      },
    };
  }

  async getRemoteTransferTransaction(
    req: AltVM.ReqRemoteTransfer,
  ): Promise<MsgRemoteTransferEncodeObject> {
    return {
      typeUrl: R.MsgRemoteTransfer.proto.type,
      value: R.MsgRemoteTransfer.proto.converter.create({
        sender: req.signer,
        token_id: req.tokenAddress,
        destination_domain: req.destinationDomainId,
        recipient: req.recipient,
        amount: req.amount,
        custom_hook_id: req.customHookAddress,
        gas_limit: req.gasLimit,
        max_fee: req.maxFee,
        custom_hook_metadata: req.customHookMetadata,
      }),
    };
  }
}
