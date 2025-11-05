import { encodeSecp256k1Pubkey } from '@cosmjs/amino';
import { Uint53 } from '@cosmjs/math';
import { EncodeObject, Registry } from '@cosmjs/proto-signing';
import {
  BankExtension,
  MsgSendEncodeObject,
  QueryClient,
  StargateClient,
  defaultRegistryTypes,
  setupBankExtension,
} from '@cosmjs/stargate';
import { CometClient, connectComet } from '@cosmjs/tendermint-rpc';

import { isTypes, warpTypes } from '@hyperlane-xyz/cosmos-types';
import { AltVM, assert, strip0x } from '@hyperlane-xyz/utils';

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
  MsgUpdateRoutingIsmOwnerEncodeObject,
} from '../hyperlane/interchain_security/messages.js';
import {
  IsmTypes as CosmosNativeIsmTypes,
  InterchainSecurityExtension,
  setupInterchainSecurityExtension,
} from '../hyperlane/interchain_security/query.js';
import {
  MsgCreateIgpEncodeObject,
  MsgCreateMerkleTreeHookEncodeObject,
  MsgCreateNoopHookEncodeObject,
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
  private readonly rpcUrls: string[];

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
    const { ism } = await this.query.interchainSecurity.Ism({
      id: req.ismAddress,
    });
    assert(ism, `found no ism for id ${req.ismAddress}`);

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
          id: req.ismAddress,
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
          id: req.ismAddress,
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
        id: req.ismAddress,
      });

    return {
      address: ism.id,
      owner: ism.owner,
      routes: ism.routes.map((r) => ({
        domainId: r.domain,
        ismAddress: r.ism,
      })),
    };
  }

  async getNoopIsm(req: AltVM.ReqNoopIsm): Promise<AltVM.ResNoopIsm> {
    const { ism } =
      await this.query.interchainSecurity.DecodedIsm<isTypes.NoopISM>({
        id: req.ismAddress,
      });

    return {
      address: ism.id,
    };
  }

  async getHookType(req: AltVM.ReqGetHookType): Promise<AltVM.HookType> {
    try {
      const { igp } = await this.query.postDispatch.Igp({
        id: req.hookAddress,
      });

      if (igp) {
        return AltVM.HookType.INTERCHAIN_GAS_PAYMASTER;
      }
    } catch {
      try {
        const { merkle_tree_hook } =
          await this.query.postDispatch.MerkleTreeHook({ id: req.hookAddress });

        if (merkle_tree_hook) {
          return AltVM.HookType.MERKLE_TREE;
        }
      } catch {
        throw new Error(`Unknown Hook Type: ${req.hookAddress}`);
      }
    }

    throw new Error(`Unknown Hook Type: ${req.hookAddress}`);
  }

  async getInterchainGasPaymasterHook(
    req: AltVM.ReqGetInterchainGasPaymasterHook,
  ): Promise<AltVM.ResGetInterchainGasPaymasterHook> {
    const { igp } = await this.query.postDispatch.Igp({ id: req.hookAddress });
    assert(igp, `found no igp for id ${req.hookAddress}`);

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
      id: req.hookAddress,
    });
    assert(
      merkle_tree_hook,
      `found no merkle tree hook for id ${req.hookAddress}`,
    );

    return {
      address: merkle_tree_hook.id,
    };
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

    let token_type: AltVM.TokenType;

    switch (token.token_type) {
      case warpTypes.HypTokenType.HYP_TOKEN_TYPE_COLLATERAL:
        token_type = AltVM.TokenType.collateral;
        break;
      case warpTypes.HypTokenType.HYP_TOKEN_TYPE_SYNTHETIC:
        token_type = AltVM.TokenType.synthetic;
        break;
      default:
        throw new Error(
          `Failed to determine token type for address ${req.tokenAddress}`,
        );
    }

    return {
      address: token.id,
      owner: token.owner,
      tokenType: token_type,
      mailboxAddress: token.origin_mailbox,
      ismAddress: token.ism_id,
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

  // ### GET CORE TXS ###

  async getCreateMailboxTransaction(
    req: AltVM.ReqCreateMailbox,
  ): Promise<MsgCreateMailboxEncodeObject> {
    return {
      typeUrl: R.MsgCreateMailbox.proto.type,
      value: R.MsgCreateMailbox.proto.converter.create({
        local_domain: req.domainId,
        owner: req.signer,
      }),
    };
  }

  async getSetDefaultIsmTransaction(
    req: AltVM.ReqSetDefaultIsm,
  ): Promise<MsgSetMailboxEncodeObject> {
    return {
      typeUrl: R.MsgSetMailbox.proto.type,
      value: R.MsgSetMailbox.proto.converter.create({
        mailbox_id: req.mailboxAddress,
        default_ism: req.ismAddress,
        owner: req.signer,
      }),
    };
  }

  async getSetDefaultHookTransaction(
    req: AltVM.ReqSetDefaultHook,
  ): Promise<MsgSetMailboxEncodeObject> {
    return {
      typeUrl: R.MsgSetMailbox.proto.type,
      value: R.MsgSetMailbox.proto.converter.create({
        mailbox_id: req.mailboxAddress,
        default_hook: req.hookAddress,
        owner: req.signer,
      }),
    };
  }

  async getSetRequiredHookTransaction(
    req: AltVM.ReqSetRequiredHook,
  ): Promise<MsgSetMailboxEncodeObject> {
    return {
      typeUrl: R.MsgSetMailbox.proto.type,
      value: R.MsgSetMailbox.proto.converter.create({
        mailbox_id: req.mailboxAddress,
        required_hook: req.hookAddress,
        owner: req.signer,
      }),
    };
  }

  async getSetMailboxOwnerTransaction(
    req: AltVM.ReqSetMailboxOwner,
  ): Promise<MsgSetMailboxEncodeObject> {
    return {
      typeUrl: R.MsgSetMailbox.proto.type,
      value: R.MsgSetMailbox.proto.converter.create({
        owner: req.signer,
        mailbox_id: req.mailboxAddress,
        new_owner: req.newOwner,
        renounce_ownership: !req.newOwner,
      }),
    };
  }

  async getCreateMerkleRootMultisigIsmTransaction(
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

  async getCreateMessageIdMultisigIsmTransaction(
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

  async getCreateRoutingIsmTransaction(
    req: AltVM.ReqCreateRoutingIsm,
  ): Promise<MsgCreateRoutingIsmEncodeObject> {
    return {
      typeUrl: R.MsgCreateRoutingIsm.proto.type,
      value: R.MsgCreateRoutingIsm.proto.converter.create({
        creator: req.signer,
        routes: req.routes.map((r) => ({
          domain: r.domainId,
          ism: r.ismAddress,
        })),
      }),
    };
  }

  async getSetRoutingIsmRouteTransaction(
    req: AltVM.ReqSetRoutingIsmRoute,
  ): Promise<MsgSetRoutingIsmDomainEncodeObject> {
    return {
      typeUrl: R.MsgSetRoutingIsmDomain.proto.type,
      value: R.MsgSetRoutingIsmDomain.proto.converter.create({
        owner: req.signer,
        ism_id: req.ismAddress,
        route: {
          domain: req.route.domainId,
          ism: req.route.ismAddress,
        },
      }),
    };
  }

  async getRemoveRoutingIsmRouteTransaction(
    req: AltVM.ReqRemoveRoutingIsmRoute,
  ): Promise<MsgRemoveRoutingIsmDomainEncodeObject> {
    return {
      typeUrl: R.MsgRemoveRoutingIsmDomain.proto.type,
      value: R.MsgRemoveRoutingIsmDomain.proto.converter.create({
        owner: req.signer,
        ism_id: req.ismAddress,
        domain: req.domainId,
      }),
    };
  }

  async getSetRoutingIsmOwnerTransaction(
    req: AltVM.ReqSetRoutingIsmOwner,
  ): Promise<MsgUpdateRoutingIsmOwnerEncodeObject> {
    return {
      typeUrl: R.MsgUpdateRoutingIsmOwner.proto.type,
      value: R.MsgUpdateRoutingIsmOwner.proto.converter.create({
        owner: req.signer,
        ism_id: req.ismAddress,
        new_owner: req.newOwner,
        renounce_ownership: !req.newOwner,
      }),
    };
  }

  async getCreateNoopIsmTransaction(
    req: AltVM.ReqCreateNoopIsm,
  ): Promise<MsgCreateNoopIsmEncodeObject> {
    return {
      typeUrl: R.MsgCreateNoopIsm.proto.type,
      value: R.MsgCreateNoopIsm.proto.converter.create({
        creator: req.signer,
      }),
    };
  }

  async getCreateMerkleTreeHookTransaction(
    req: AltVM.ReqCreateMerkleTreeHook,
  ): Promise<MsgCreateMerkleTreeHookEncodeObject> {
    return {
      typeUrl: R.MsgCreateMerkleTreeHook.proto.type,
      value: R.MsgCreateMerkleTreeHook.proto.converter.create({
        owner: req.signer,
        mailbox_id: req.mailboxAddress,
      }),
    };
  }

  async getCreateInterchainGasPaymasterHookTransaction(
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

  async getSetInterchainGasPaymasterHookOwnerTransaction(
    req: AltVM.ReqSetInterchainGasPaymasterHookOwner,
  ): Promise<MsgSetIgpOwnerEncodeObject> {
    return {
      typeUrl: R.MsgSetIgpOwner.proto.type,
      value: R.MsgSetIgpOwner.proto.converter.create({
        owner: req.signer,
        igp_id: req.hookAddress,
        new_owner: req.newOwner,
        renounce_ownership: !req.newOwner,
      }),
    };
  }

  async getSetDestinationGasConfigTransaction(
    req: AltVM.ReqSetDestinationGasConfig,
  ): Promise<MsgSetDestinationGasConfigEncodeObject> {
    return {
      typeUrl: R.MsgSetDestinationGasConfig.proto.type,
      value: R.MsgSetDestinationGasConfig.proto.converter.create({
        owner: req.signer,
        igp_id: req.hookAddress,
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

  async getRemoveDestinationGasConfigTransaction(
    _req: AltVM.ReqRemoveDestinationGasConfig,
  ): Promise<EncodeObject> {
    throw new Error(
      `RemoveDestinationGasConfig is currently not supported on Cosmos Native`,
    );
  }

  async getCreateNoopHookTransaction(
    req: AltVM.ReqCreateNoopHook,
  ): Promise<MsgCreateNoopHookEncodeObject> {
    return {
      typeUrl: R.MsgCreateNoopHook.proto.type,
      value: R.MsgCreateNoopHook.proto.converter.create({
        owner: req.signer,
      }),
    };
  }

  async getCreateValidatorAnnounceTransaction(
    _req: AltVM.ReqCreateValidatorAnnounce,
  ): Promise<EncodeObject> {
    throw new Error(
      'Cosmos Native does not support populateCreateValidatorAnnounce',
    );
  }

  // ### GET WARP TXS ###

  async getCreateNativeTokenTransaction(
    _req: AltVM.ReqCreateNativeToken,
  ): Promise<EncodeObject> {
    throw new Error(`Native Token is not supported on Cosmos Native`);
  }

  async getCreateCollateralTokenTransaction(
    req: AltVM.ReqCreateCollateralToken,
  ): Promise<MsgCreateCollateralTokenEncodeObject> {
    return {
      typeUrl: R.MsgCreateCollateralToken.proto.type,
      value: R.MsgCreateCollateralToken.proto.converter.create({
        owner: req.signer,
        origin_mailbox: req.mailboxAddress,
        origin_denom: req.collateralDenom,
      }),
    };
  }

  async getCreateSyntheticTokenTransaction(
    req: AltVM.ReqCreateSyntheticToken,
  ): Promise<MsgCreateSyntheticTokenEncodeObject> {
    return {
      typeUrl: R.MsgCreateSyntheticToken.proto.type,
      value: R.MsgCreateSyntheticToken.proto.converter.create({
        owner: req.signer,
        origin_mailbox: req.mailboxAddress,
      }),
    };
  }

  async getSetTokenOwnerTransaction(
    req: AltVM.ReqSetTokenOwner,
  ): Promise<MsgSetTokenEncodeObject> {
    return {
      typeUrl: R.MsgSetToken.proto.type,
      value: R.MsgSetToken.proto.converter.create({
        owner: req.signer,
        token_id: req.tokenAddress,
        new_owner: req.newOwner,
        renounce_ownership: !req.newOwner,
      }),
    };
  }

  async getSetTokenIsmTransaction(
    req: AltVM.ReqSetTokenIsm,
  ): Promise<MsgSetTokenEncodeObject> {
    return {
      typeUrl: R.MsgSetToken.proto.type,
      value: R.MsgSetToken.proto.converter.create({
        owner: req.signer,
        token_id: req.tokenAddress,
        ism_id: req.ismAddress,
      }),
    };
  }

  async getEnrollRemoteRouterTransaction(
    req: AltVM.ReqEnrollRemoteRouter,
  ): Promise<MsgEnrollRemoteRouterEncodeObject> {
    return {
      typeUrl: R.MsgEnrollRemoteRouter.proto.type,
      value: R.MsgEnrollRemoteRouter.proto.converter.create({
        owner: req.signer,
        token_id: req.tokenAddress,
        remote_router: {
          receiver_domain: req.remoteRouter.receiverDomainId,
          receiver_contract: req.remoteRouter.receiverAddress,
          gas: req.remoteRouter.gas,
        },
      }),
    };
  }

  async getUnenrollRemoteRouterTransaction(
    req: AltVM.ReqUnenrollRemoteRouter,
  ): Promise<MsgUnrollRemoteRouterEncodeObject> {
    return {
      typeUrl: R.MsgUnrollRemoteRouter.proto.type,
      value: R.MsgUnrollRemoteRouter.proto.converter.create({
        owner: req.signer,
        token_id: req.tokenAddress,
        receiver_domain: req.receiverDomainId,
      }),
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
