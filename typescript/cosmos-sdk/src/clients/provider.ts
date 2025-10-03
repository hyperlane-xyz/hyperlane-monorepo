import { encodeSecp256k1Pubkey } from '@cosmjs/amino';
import { Uint53 } from '@cosmjs/math';
import { EncodeObject, Registry } from '@cosmjs/proto-signing';
import {
  BankExtension,
  QueryClient,
  StargateClient,
  defaultRegistryTypes,
  setupBankExtension,
} from '@cosmjs/stargate';
import { CometClient, connectComet } from '@cosmjs/tendermint-rpc';

import { isTypes, warpTypes } from '@hyperlane-xyz/cosmos-types';
import { AltVM, assert } from '@hyperlane-xyz/utils';

import {
  MsgCreateMailboxEncodeObject,
  MsgSetMailboxEncodeObject,
} from '../hyperlane/core/messages.js';
import { CoreExtension, setupCoreExtension } from '../hyperlane/core/query.js';
import {
  MsgCreateMerkleRootMultisigIsmEncodeObject,
  MsgCreateMessageIdMultisigIsmEncodeObject,
  MsgCreateNoopIsmEncodeObject,
  MsgCreateRoutingIsmEncodeObject,
  MsgRemoveRoutingIsmDomainEncodeObject,
  MsgSetRoutingIsmDomainEncodeObject,
} from '../hyperlane/interchain_security/messages.js';
import {
  IsmTypes as CosmosNativeIsmTypes,
  InterchainSecurityExtension,
  setupInterchainSecurityExtension,
} from '../hyperlane/interchain_security/query.js';
import {
  MsgCreateIgpEncodeObject,
  MsgCreateMerkleTreeHookEncodeObject,
  MsgSetDestinationGasConfigEncodeObject,
  MsgSetIgpOwnerEncodeObject,
} from '../hyperlane/post_dispatch/messages.js';
import {
  PostDispatchExtension,
  setupPostDispatchExtension,
} from '../hyperlane/post_dispatch/query.js';
import {
  MsgCreateCollateralTokenEncodeObject,
  MsgCreateSyntheticTokenEncodeObject,
  MsgEnrollRemoteRouterEncodeObject,
  MsgRemoteTransferEncodeObject,
  MsgSetTokenEncodeObject,
  MsgUnrollRemoteRouterEncodeObject,
} from '../hyperlane/warp/messages.js';
import { WarpExtension, setupWarpExtension } from '../hyperlane/warp/query.js';
import { COSMOS_MODULE_MESSAGE_REGISTRY as R } from '../registry.js';

export class CosmosNativeProvider implements AltVM.IProvider<EncodeObject> {
  private readonly query: QueryClient &
    BankExtension &
    WarpExtension &
    CoreExtension &
    InterchainSecurityExtension &
    PostDispatchExtension;
  private readonly registry: Registry;
  private readonly cometClient: CometClient;
  private readonly rpcUrl: string;

  static async connect(rpcUrl: string): Promise<CosmosNativeProvider> {
    const client = await connectComet(rpcUrl);
    return new CosmosNativeProvider(client, rpcUrl);
  }

  protected constructor(cometClient: CometClient, rpcUrl: string) {
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
    this.rpcUrl = rpcUrl;
  }

  // ### QUERY BASE ###

  async isHealthy() {
    const status = await this.cometClient.status();
    return status.syncInfo.latestBlockHeight > 0;
  }

  getRpcUrl(): string {
    return this.rpcUrl;
  }

  async getHeight() {
    const status = await this.cometClient.status();
    return status.syncInfo.latestBlockHeight;
  }

  async getBalance(req: AltVM.ReqGetBalance): Promise<AltVM.ResGetBalance> {
    const coin = await this.query.bank.balance(req.address, req.denom);
    return BigInt(coin.amount);
  }

  async getTotalSupply(
    req: AltVM.ReqGetTotalSupply,
  ): Promise<AltVM.ResGetTotalSupply> {
    const coin = await this.query.bank.supplyOf(req.denom);
    return BigInt(coin.amount);
  }

  async estimateTransactionFee(
    req: AltVM.ReqEstimateTransactionFee,
  ): Promise<AltVM.ResEstimateTransactionFee> {
    assert(
      req.senderPubKey,
      `Cosmos Native requires a sender public key to estimate the transaction fee`,
    );
    const stargateClient = await StargateClient.connect(this.rpcUrl);

    const message = this.registry.encodeAsAny(req.transaction);
    const pubKey = encodeSecp256k1Pubkey(
      new Uint8Array(Buffer.from(req.senderPubKey, 'hex')),
    );

    const queryClient = stargateClient['getQueryClient']();
    assert(queryClient, `queryClient could not be found on stargate client`);

    const { sequence } = await stargateClient.getSequence(req.sender);
    const { gasInfo } = await queryClient.tx.simulate(
      [message],
      req.memo,
      pubKey,
      sequence,
    );
    const gasUnits = Uint53.fromString(
      gasInfo?.gasUsed.toString() ?? '0',
    ).toNumber();

    const gasPrice = parseFloat(req.estimatedGasPrice.toString());
    return { gasUnits, gasPrice, fee: Math.floor(gasUnits * gasPrice) };
  }

  // ### QUERY CORE ###

  async getMailbox(req: AltVM.ReqGetMailbox): Promise<AltVM.ResGetMailbox> {
    const { mailbox } = await this.query.core.Mailbox({ id: req.mailboxId });
    assert(mailbox, `found no mailbox for id ${req.mailboxId}`);

    return {
      address: mailbox.id,
      owner: mailbox.owner,
      localDomain: mailbox.local_domain,
      defaultIsm: mailbox.default_ism,
      defaultHook: mailbox.default_hook,
      requiredHook: mailbox.required_hook,
      messageSent: mailbox.message_sent,
      messageReceived: mailbox.message_received,
    };
  }

  async delivered(req: AltVM.ReqDelivered): Promise<AltVM.ResDelivered> {
    const { delivered } = await this.query.core.Delivered({
      id: req.mailboxId,
      message_id: req.messageId,
    });
    return delivered;
  }

  async getIsmType(req: AltVM.ReqGetIsmType): Promise<AltVM.ResGetIsmType> {
    const { ism } = await this.query.interchainSecurity.Ism({ id: req.ismId });
    assert(ism, `found no ism for id ${req.ismId}`);

    switch (ism.type_url) {
      case CosmosNativeIsmTypes.MerkleRootMultisigISM:
        return AltVM.IsmType.MERKLE_ROOT_MULTISIG;
      case CosmosNativeIsmTypes.MessageIdMultisigISM:
        return AltVM.IsmType.MESSAGE_ID_MULTISIG;
      case CosmosNativeIsmTypes.RoutingISM:
        return AltVM.IsmType.ROUTING;
      case CosmosNativeIsmTypes.NoopISM:
        return AltVM.IsmType.TEST_ISM;
      default:
        throw new Error(`Unknown ISM ModuleType: ${ism.type_url}`);
    }
  }

  async getMessageIdMultisigIsm(
    req: AltVM.ReqMessageIdMultisigIsm,
  ): Promise<AltVM.ResMessageIdMultisigIsm> {
    const { ism } =
      await this.query.interchainSecurity.DecodedIsm<isTypes.MessageIdMultisigISM>(
        {
          id: req.ismId,
        },
      );

    return {
      address: ism.id,
      validators: ism.validators,
      threshold: ism.threshold,
    };
  }

  async getMerkleRootMultisigIsm(
    req: AltVM.ReqMerkleRootMultisigIsm,
  ): Promise<AltVM.ResMerkleRootMultisigIsm> {
    const { ism } =
      await this.query.interchainSecurity.DecodedIsm<isTypes.MerkleRootMultisigISM>(
        {
          id: req.ismId,
        },
      );

    return {
      address: ism.id,
      validators: ism.validators,
      threshold: ism.threshold,
    };
  }

  async getRoutingIsm(req: AltVM.ReqRoutingIsm): Promise<AltVM.ResRoutingIsm> {
    const { ism } =
      await this.query.interchainSecurity.DecodedIsm<isTypes.RoutingISM>({
        id: req.ismId,
      });

    return {
      address: ism.id,
      owner: ism.owner,
      routes: ism.routes.map((r) => ({ domainId: r.domain, ismId: r.ism })),
    };
  }

  async getNoopIsm(req: AltVM.ReqNoopIsm): Promise<AltVM.ResNoopIsm> {
    const { ism } =
      await this.query.interchainSecurity.DecodedIsm<isTypes.NoopISM>({
        id: req.ismId,
      });

    return {
      address: ism.id,
    };
  }

  async getHookType(req: AltVM.ReqGetHookType): Promise<AltVM.ResGetHookType> {
    try {
      const { igp } = await this.query.postDispatch.Igp({ id: req.hookId });

      if (igp) {
        return AltVM.HookType.INTERCHAIN_GAS_PAYMASTER;
      }
    } catch {
      try {
        const { merkle_tree_hook } =
          await this.query.postDispatch.MerkleTreeHook({ id: req.hookId });

        if (merkle_tree_hook) {
          return AltVM.HookType.MERKLE_TREE;
        }
      } catch {
        throw new Error(`Unknown Hook Type: ${req.hookId}`);
      }
    }

    throw new Error(`Unknown Hook Type: ${req.hookId}`);
  }

  async getInterchainGasPaymasterHook(
    req: AltVM.ReqGetInterchainGasPaymasterHook,
  ): Promise<AltVM.ResGetInterchainGasPaymasterHook> {
    const { igp } = await this.query.postDispatch.Igp({ id: req.hookId });
    assert(igp, `found no igp for id ${req.hookId}`);

    const { destination_gas_configs } =
      await this.query.postDispatch.DestinationGasConfigs({
        id: igp.id,
      });

    const configs: {
      [domainId: string]: {
        gasOracle: {
          tokenExchangeRate: string;
          gasPrice: string;
        };
        gasOverhead: string;
      };
    } = {};

    for (const config of destination_gas_configs) {
      configs[config.remote_domain] = {
        gasOracle: {
          tokenExchangeRate: config.gas_oracle?.token_exchange_rate ?? '0',
          gasPrice: config.gas_oracle?.gas_price ?? '0',
        },
        gasOverhead: config.gas_overhead,
      };
    }

    return {
      address: igp.id,
      owner: igp.owner,
      destinationGasConfigs: configs,
    };
  }

  async getMerkleTreeHook(
    req: AltVM.ReqGetMerkleTreeHook,
  ): Promise<AltVM.ResGetMerkleTreeHook> {
    const { merkle_tree_hook } = await this.query.postDispatch.MerkleTreeHook({
      id: req.hookId,
    });
    assert(merkle_tree_hook, `found no merkle tree hook for id ${req.hookId}`);

    return {
      address: merkle_tree_hook.id,
    };
  }

  // ### QUERY WARP ###

  async getToken(req: AltVM.ReqGetToken): Promise<AltVM.ResGetToken> {
    const { token } = await this.query.warp.Token({
      id: req.tokenId,
    });
    assert(token, `found no token for id ${req.tokenId}`);

    let token_type: AltVM.TokenType;

    switch (token.token_type) {
      case warpTypes.HypTokenType.HYP_TOKEN_TYPE_COLLATERAL:
        token_type = AltVM.TokenType.COLLATERAL;
        break;
      case warpTypes.HypTokenType.HYP_TOKEN_TYPE_SYNTHETIC:
        token_type = AltVM.TokenType.SYNTHETIC;
        break;
      default:
        throw new Error(
          `Failed to determine token type for address ${req.tokenId}`,
        );
    }

    return {
      address: token.id,
      owner: token.owner,
      tokenType: token_type,
      mailboxId: token.origin_mailbox,
      ismId: token.ism_id,
      originDenom: token.origin_denom,
      name: '',
      symbol: '',
      description: '',
      divisibility: 0,
    };
  }

  async getRemoteRouters(
    req: AltVM.ReqGetRemoteRouters,
  ): Promise<AltVM.ResGetRemoteRouters> {
    const { remote_routers } = await this.query.warp.RemoteRouters({
      id: req.tokenId,
    });

    return {
      address: req.tokenId,
      remoteRouters: remote_routers.map((r) => ({
        receiverDomainId: r.receiver_domain,
        receiverContract: r.receiver_contract,
        gas: r.gas,
      })),
    };
  }

  async getBridgedSupply(
    req: AltVM.ReqGetBridgedSupply,
  ): Promise<AltVM.ResGetBridgedSupply> {
    const { bridged_supply } = await this.query.warp.BridgedSupply({
      id: req.tokenId,
    });
    assert(
      bridged_supply,
      `found no bridged supply for token id ${req.tokenId}`,
    );

    return BigInt(bridged_supply.amount);
  }

  async quoteRemoteTransfer(
    req: AltVM.ReqQuoteRemoteTransfer,
  ): Promise<AltVM.ResQuoteRemoteTransfer> {
    const { gas_payment } = await this.query.warp.QuoteRemoteTransfer({
      id: req.tokenId,
      destination_domain: req.destinationDomainId.toString(),
      custom_hook_id: req.customHookId,
      custom_hook_metadata: req.customHookMetadata,
    });
    assert(
      gas_payment[0],
      `found no quote for token id ${req.tokenId} and destination domain ${req.destinationDomainId}`,
    );

    return {
      denom: gas_payment[0].denom,
      amount: BigInt(gas_payment[0].amount),
    };
  }

  // ### POPULATE CORE ###

  async populateCreateMailbox(
    req: AltVM.ReqCreateMailbox,
  ): Promise<MsgCreateMailboxEncodeObject> {
    return {
      typeUrl: R.MsgCreateMailbox.proto.type,
      value: R.MsgCreateMailbox.proto.converter.create({
        local_domain: req.domainId,
        default_ism: req.defaultIsmId,
        owner: req.signer,
      }),
    };
  }

  async populateSetDefaultIsm(
    req: AltVM.ReqSetDefaultIsm,
  ): Promise<MsgSetMailboxEncodeObject> {
    return {
      typeUrl: R.MsgSetMailbox.proto.type,
      value: R.MsgSetMailbox.proto.converter.create({
        mailbox_id: req.mailboxId,
        default_ism: req.ismId,
        owner: req.signer,
      }),
    };
  }

  async populateSetDefaultHook(
    req: AltVM.ReqSetDefaultHook,
  ): Promise<MsgSetMailboxEncodeObject> {
    return {
      typeUrl: R.MsgSetMailbox.proto.type,
      value: R.MsgSetMailbox.proto.converter.create({
        mailbox_id: req.mailboxId,
        default_hook: req.hookId,
        owner: req.signer,
      }),
    };
  }

  async populateSetRequiredHook(
    req: AltVM.ReqSetRequiredHook,
  ): Promise<MsgSetMailboxEncodeObject> {
    return {
      typeUrl: R.MsgSetMailbox.proto.type,
      value: R.MsgSetMailbox.proto.converter.create({
        mailbox_id: req.mailboxId,
        required_hook: req.hookId,
        owner: req.signer,
      }),
    };
  }

  async populateSetMailboxOwner(
    req: AltVM.ReqSetMailboxOwner,
  ): Promise<MsgSetMailboxEncodeObject> {
    return {
      typeUrl: R.MsgSetMailbox.proto.type,
      value: R.MsgSetMailbox.proto.converter.create({
        owner: req.signer,
        mailbox_id: req.mailboxId,
        new_owner: req.newOwner,
        renounce_ownership: !req.newOwner,
      }),
    };
  }

  async populateCreateMerkleRootMultisigIsm(
    req: AltVM.ReqCreateMerkleRootMultisigIsm,
  ): Promise<MsgCreateMerkleRootMultisigIsmEncodeObject> {
    return {
      typeUrl: R.MsgCreateMerkleRootMultisigIsm.proto.type,
      value: R.MsgCreateMerkleRootMultisigIsm.proto.converter.create({
        creator: req.signer,
        validators: req.validators,
        threshold: req.threshold,
      }),
    };
  }

  async populateCreateMessageIdMultisigIsm(
    req: AltVM.ReqCreateMessageIdMultisigIsm,
  ): Promise<MsgCreateMessageIdMultisigIsmEncodeObject> {
    return {
      typeUrl: R.MsgCreateMessageIdMultisigIsm.proto.type,
      value: R.MsgCreateMessageIdMultisigIsm.proto.converter.create({
        creator: req.signer,
        validators: req.validators,
        threshold: req.threshold,
      }),
    };
  }

  async populateCreateRoutingIsm(
    req: AltVM.ReqCreateRoutingIsm,
  ): Promise<MsgCreateRoutingIsmEncodeObject> {
    return {
      typeUrl: R.MsgCreateRoutingIsm.proto.type,
      value: R.MsgCreateRoutingIsm.proto.converter.create({
        creator: req.signer,
        routes: req.routes.map((r) => ({ domain: r.domainId, ism: r.ism })),
      }),
    };
  }

  async populateSetRoutingIsmRoute(
    req: AltVM.ReqSetRoutingIsmRoute,
  ): Promise<MsgSetRoutingIsmDomainEncodeObject> {
    return {
      typeUrl: R.MsgSetRoutingIsmDomain.proto.type,
      value: R.MsgSetRoutingIsmDomain.proto.converter.create({
        owner: req.signer,
        ism_id: req.ismId,
        route: {
          domain: req.route.domainId,
          ism: req.route.ismId,
        },
      }),
    };
  }

  async populateRemoveRoutingIsmRoute(
    req: AltVM.ReqRemoveRoutingIsmRoute,
  ): Promise<MsgRemoveRoutingIsmDomainEncodeObject> {
    return {
      typeUrl: R.MsgRemoveRoutingIsmDomain.proto.type,
      value: R.MsgRemoveRoutingIsmDomain.proto.converter.create({
        owner: req.signer,
        ism_id: req.ismId,
        domain: req.domainId,
      }),
    };
  }

  async populateSetRoutingIsmOwner(
    req: AltVM.ReqSetRoutingIsmOwner,
  ): Promise<any> {
    return {
      typeUrl: R.MsgUpdateRoutingIsmOwner.proto.type,
      value: R.MsgUpdateRoutingIsmOwner.proto.converter.create({
        owner: req.signer,
        ism_id: req.ismId,
        new_owner: req.newOwner,
        renounce_ownership: !req.newOwner,
      }),
    };
  }

  async populateCreateNoopIsm(
    req: AltVM.ReqCreateNoopIsm,
  ): Promise<MsgCreateNoopIsmEncodeObject> {
    return {
      typeUrl: R.MsgCreateNoopIsm.proto.type,
      value: R.MsgCreateNoopIsm.proto.converter.create({
        creator: req.signer,
      }),
    };
  }

  async populateCreateMerkleTreeHook(
    req: AltVM.ReqCreateMerkleTreeHook,
  ): Promise<MsgCreateMerkleTreeHookEncodeObject> {
    return {
      typeUrl: R.MsgCreateMerkleTreeHook.proto.type,
      value: R.MsgCreateMerkleTreeHook.proto.converter.create({
        owner: req.signer,
        mailbox_id: req.mailboxId,
      }),
    };
  }

  async populateCreateInterchainGasPaymasterHook(
    req: AltVM.ReqCreateInterchainGasPaymasterHook,
  ): Promise<MsgCreateIgpEncodeObject> {
    return {
      typeUrl: R.MsgCreateIgp.proto.type,
      value: R.MsgCreateIgp.proto.converter.create({
        owner: req.signer,
        denom: req.denom,
      }),
    };
  }

  async populateSetInterchainGasPaymasterHookOwner(
    req: AltVM.ReqSetInterchainGasPaymasterHookOwner,
  ): Promise<MsgSetIgpOwnerEncodeObject> {
    return {
      typeUrl: R.MsgSetIgpOwner.proto.type,
      value: R.MsgSetIgpOwner.proto.converter.create({
        owner: req.signer,
        igp_id: req.hookId,
        new_owner: req.newOwner,
        renounce_ownership: !req.newOwner,
      }),
    };
  }

  async populateSetDestinationGasConfig(
    req: AltVM.ReqSetDestinationGasConfig,
  ): Promise<MsgSetDestinationGasConfigEncodeObject> {
    return {
      typeUrl: R.MsgSetDestinationGasConfig.proto.type,
      value: R.MsgSetDestinationGasConfig.proto.converter.create({
        owner: req.signer,
        igp_id: req.hookId,
        destination_gas_config: {
          remote_domain: req.destinationGasConfig.remoteDomainId,
          gas_overhead: req.destinationGasConfig.gasOverhead,
          gas_oracle: {
            token_exchange_rate:
              req.destinationGasConfig.gasOracle.tokenExchangeRate,
            gas_price: req.destinationGasConfig.gasOracle.gasPrice,
          },
        },
      }),
    };
  }

  async populateCreateValidatorAnnounce(
    _req: AltVM.ReqCreateValidatorAnnounce,
  ): Promise<any> {
    throw new Error(
      'Cosmos Native does not support populateCreateValidatorAnnounce',
    );
  }

  // ### POPULATE WARP ###

  async populateCreateCollateralToken(
    req: AltVM.ReqCreateCollateralToken,
  ): Promise<MsgCreateCollateralTokenEncodeObject> {
    return {
      typeUrl: R.MsgCreateCollateralToken.proto.type,
      value: R.MsgCreateCollateralToken.proto.converter.create({
        owner: req.signer,
        origin_mailbox: req.mailboxId,
        origin_denom: req.originDenom,
      }),
    };
  }

  async populateCreateSyntheticToken(
    req: AltVM.ReqCreateSyntheticToken,
  ): Promise<MsgCreateSyntheticTokenEncodeObject> {
    return {
      typeUrl: R.MsgCreateSyntheticToken.proto.type,
      value: R.MsgCreateSyntheticToken.proto.converter.create({
        owner: req.signer,
        origin_mailbox: req.mailboxId,
      }),
    };
  }

  async populateSetTokenOwner(
    req: AltVM.ReqSetTokenOwner,
  ): Promise<MsgSetTokenEncodeObject> {
    return {
      typeUrl: R.MsgSetToken.proto.type,
      value: R.MsgSetToken.proto.converter.create({
        owner: req.signer,
        token_id: req.tokenId,
        new_owner: req.newOwner,
        renounce_ownership: !req.newOwner,
      }),
    };
  }

  async populateSetTokenIsm(
    req: AltVM.ReqSetTokenIsm,
  ): Promise<MsgSetTokenEncodeObject> {
    return {
      typeUrl: R.MsgSetToken.proto.type,
      value: R.MsgSetToken.proto.converter.create({
        owner: req.signer,
        token_id: req.tokenId,
        ism_id: req.ismId,
      }),
    };
  }

  async populateEnrollRemoteRouter(
    req: AltVM.ReqEnrollRemoteRouter,
  ): Promise<MsgEnrollRemoteRouterEncodeObject> {
    return {
      typeUrl: R.MsgEnrollRemoteRouter.proto.type,
      value: R.MsgEnrollRemoteRouter.proto.converter.create({
        owner: req.signer,
        token_id: req.tokenId,
        remote_router: {
          receiver_domain: req.remoteRouter.receiverDomainId,
          receiver_contract: req.remoteRouter.receiverAddress,
          gas: req.remoteRouter.gas,
        },
      }),
    };
  }

  async populateUnenrollRemoteRouter(
    req: AltVM.ReqUnenrollRemoteRouter,
  ): Promise<MsgUnrollRemoteRouterEncodeObject> {
    return {
      typeUrl: R.MsgUnrollRemoteRouter.proto.type,
      value: R.MsgUnrollRemoteRouter.proto.converter.create({
        owner: req.signer,
        token_id: req.tokenId,
        receiver_domain: req.receiverDomainId,
      }),
    };
  }

  async populateRemoteTransfer(
    req: AltVM.ReqRemoteTransfer,
  ): Promise<MsgRemoteTransferEncodeObject> {
    return {
      typeUrl: R.MsgRemoteTransfer.proto.type,
      value: R.MsgRemoteTransfer.proto.converter.create({
        sender: req.signer,
        token_id: req.tokenId,
        destination_domain: req.destinationDomainId,
        recipient: req.recipient,
        amount: req.amount,
        custom_hook_id: req.customHookId,
        gas_limit: req.gasLimit,
        max_fee: req.maxFee,
        custom_hook_metadata: req.customHookMetadata,
      }),
    };
  }
}
