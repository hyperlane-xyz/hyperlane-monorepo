import { Registry } from '@cosmjs/proto-signing';
import {
  BankExtension,
  QueryClient,
  defaultRegistryTypes,
  setupBankExtension,
} from '@cosmjs/stargate';
import { CometClient, connectComet } from '@cosmjs/tendermint-rpc';

import { isTypes, warpTypes } from '@hyperlane-xyz/cosmos-types';
import { MultiVM, assert } from '@hyperlane-xyz/utils';

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
  InterchainSecurityExtension,
  IsmTypes,
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

export class CosmosNativeProviderFactory
  implements MultiVM.MultiVmProviderFactory
{
  static async connect(rpcUrl: string): Promise<CosmosNativeProvider> {
    const client = await connectComet(rpcUrl);
    return new CosmosNativeProvider(client);
  }
}

export class CosmosNativeProvider implements MultiVM.IMultiVMProvider {
  private readonly query: QueryClient &
    BankExtension &
    WarpExtension &
    CoreExtension &
    InterchainSecurityExtension &
    PostDispatchExtension;
  private readonly registry: Registry;
  private readonly cometClient: CometClient;

  constructor(cometClient: CometClient) {
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
  }

  // ### QUERY BASE ###

  async isHealthy() {
    const status = await this.cometClient.status();
    return status.syncInfo.latestBlockHeight > 0;
  }

  async getBalance(req: MultiVM.ReqGetBalance): Promise<MultiVM.ResGetBalance> {
    const coin = await this.query.bank.balance(req.address, req.denom);
    return BigInt(coin.amount);
  }

  async getTotalSupply(
    req: MultiVM.ReqGetTotalSupply,
  ): Promise<MultiVM.ResGetTotalSupply> {
    const coin = await this.query.bank.supplyOf(req.denom);
    return BigInt(coin.amount);
  }

  async estimateTransactionFee(
    _req: MultiVM.ReqEstimateTransactionFee,
  ): Promise<MultiVM.ResEstimateTransactionFee> {
    return { gasUnits: 0n, gasPrice: 0, fee: 0n };
  }

  // ### QUERY CORE ###

  async getMailbox(req: MultiVM.ReqGetMailbox): Promise<MultiVM.ResGetMailbox> {
    const { mailbox } = await this.query.core.Mailbox({ id: req.mailbox_id });
    assert(mailbox, `found no mailbox for id ${req.mailbox_id}`);

    return {
      address: mailbox.id,
      owner: mailbox.owner,
      local_domain: mailbox.local_domain,
      default_ism: mailbox.default_ism,
      default_hook: mailbox.default_hook,
      required_hook: mailbox.required_hook,
    };
  }

  async getIsmType(req: MultiVM.ReqGetIsmType): Promise<MultiVM.ResGetIsmType> {
    const { ism } = await this.query.interchainSecurity.Ism({ id: req.ism_id });
    assert(ism, `found no ism for id ${req.ism_id}`);

    switch (ism.type_url) {
      case IsmTypes.MerkleRootMultisigISM:
        return 'MERKLE_ROOT_MULTISIG_ISM';
      case IsmTypes.MessageIdMultisigISM:
        return 'MESSAGE_ID_MULTISIG_ISM';
      case IsmTypes.RoutingISM:
        return 'ROUTING_ISM';
      case IsmTypes.NoopISM:
        return 'NOOP_ISM';
      default:
        throw new Error(`Unknown ISM ModuleType: ${ism.type_url}`);
    }
  }

  async getMessageIdMultisigIsm(
    req: MultiVM.ReqMessageIdMultisigIsm,
  ): Promise<MultiVM.ResMessageIdMultisigIsm> {
    const { ism } =
      await this.query.interchainSecurity.DecodedIsm<isTypes.MessageIdMultisigISM>(
        {
          id: req.ism_id,
        },
      );

    return {
      address: ism.id,
      validators: ism.validators,
      threshold: ism.threshold,
    };
  }

  async getMerkleRootMultisigIsm(
    req: MultiVM.ReqMerkleRootMultisigIsm,
  ): Promise<MultiVM.ResMerkleRootMultisigIsm> {
    const { ism } =
      await this.query.interchainSecurity.DecodedIsm<isTypes.MerkleRootMultisigISM>(
        {
          id: req.ism_id,
        },
      );

    return {
      address: ism.id,
      validators: ism.validators,
      threshold: ism.threshold,
    };
  }

  async getRoutingIsm(
    req: MultiVM.ReqRoutingIsm,
  ): Promise<MultiVM.ResRoutingIsm> {
    const { ism } =
      await this.query.interchainSecurity.DecodedIsm<isTypes.RoutingISM>({
        id: req.ism_id,
      });

    return {
      address: ism.id,
      owner: ism.owner,
      routes: ism.routes,
    };
  }

  async getNoopIsm(req: MultiVM.ReqNoopIsm): Promise<MultiVM.ResNoopIsm> {
    const { ism } =
      await this.query.interchainSecurity.DecodedIsm<isTypes.NoopISM>({
        id: req.ism_id,
      });

    return {
      address: ism.id,
    };
  }

  async getHookType(
    req: MultiVM.ReqGetHookType,
  ): Promise<MultiVM.ResGetHookType> {
    try {
      const { igp } = await this.query.postDispatch.Igp({ id: req.hook_id });

      if (igp) {
        return 'INTERCHAIN_GAS_PAYMASTER';
      }
    } catch {}

    try {
      const { merkle_tree_hook } = await this.query.postDispatch.MerkleTreeHook(
        { id: req.hook_id },
      );

      if (merkle_tree_hook) {
        return 'MERKLE_TREE_HOOK';
      }
    } catch {}

    throw new Error(`Unknown Hook Type: ${req.hook_id}`);
  }

  async getInterchainGasPaymasterHook(
    req: MultiVM.ReqGetInterchainGasPaymasterHook,
  ): Promise<MultiVM.ResGetInterchainGasPaymasterHook> {
    const { igp } = await this.query.postDispatch.Igp({ id: req.hook_id });
    assert(igp, `found no igp for id ${req.hook_id}`);

    const { destination_gas_configs } =
      await this.query.postDispatch.DestinationGasConfigs({
        id: igp.id,
      });

    let configs: {
      [domain_id: string]: {
        gas_oracle: {
          token_exchange_rate: string;
          gas_price: string;
        };
        gas_overhead: string;
      };
    } = {};

    for (const config of destination_gas_configs) {
      configs[config.remote_domain] = {
        gas_oracle: config.gas_oracle || {
          token_exchange_rate: '0',
          gas_price: '0',
        },
        gas_overhead: config.gas_overhead,
      };
    }

    return {
      address: igp.id,
      owner: igp.owner,
      destination_gas_configs: configs,
    };
  }

  async getMerkleTreeHook(
    req: MultiVM.ReqGetMerkleTreeHook,
  ): Promise<MultiVM.ResGetMerkleTreeHook> {
    const { merkle_tree_hook } = await this.query.postDispatch.MerkleTreeHook({
      id: req.hook_id,
    });
    assert(merkle_tree_hook, `found no merkle tree hook for id ${req.hook_id}`);

    return {
      address: merkle_tree_hook.id,
    };
  }

  // ### QUERY WARP ###

  async getToken(req: MultiVM.ReqGetToken): Promise<MultiVM.ResGetToken> {
    const { token } = await this.query.warp.Token({
      id: req.token_id,
    });
    assert(token, `found no token for id ${req.token_id}`);

    let token_type;

    switch (token.token_type) {
      case warpTypes.HypTokenType.HYP_TOKEN_TYPE_COLLATERAL:
        token_type = 'COLLATERAL';
        break;
      case warpTypes.HypTokenType.HYP_TOKEN_TYPE_SYNTHETIC:
        token_type = 'SYNTHETIC';
        break;
      default:
        throw new Error(
          `Failed to determine token type for address ${req.token_id}`,
        );
    }

    return {
      address: token.id,
      owner: token.owner,
      token_type: token_type as 'COLLATERAL' | 'SYNTHETIC',
      mailbox: token.origin_mailbox,
      ism: token.ism_id,
      origin_denom: token.origin_denom,
      name: '',
      symbol: '',
      description: '',
      divisibility: 0,
    };
  }

  async getRemoteRouters(
    req: MultiVM.ReqGetRemoteRouters,
  ): Promise<MultiVM.ResGetRemoteRouters> {
    const { remote_routers } = await this.query.warp.RemoteRouters({
      id: req.token_id,
    });

    return {
      address: req.token_id,
      remote_routers: remote_routers.map((r) => ({
        receiver_domain_id: r.receiver_domain,
        receiver_contract: r.receiver_contract,
        gas: r.gas,
      })),
    };
  }

  async getBridgedSupply(
    req: MultiVM.ReqGetBridgedSupply,
  ): Promise<MultiVM.ResGetBridgedSupply> {
    const { bridged_supply } = await this.query.warp.BridgedSupply({
      id: req.token_id,
    });
    assert(
      bridged_supply,
      `found no bridged supply for token id ${req.token_id}`,
    );

    return BigInt(bridged_supply.amount);
  }

  async quoteRemoteTransfer(
    req: MultiVM.ReqQuoteRemoteTransfer,
  ): Promise<MultiVM.ResQuoteRemoteTransfer> {
    const { gas_payment } = await this.query.warp.QuoteRemoteTransfer({
      id: req.token_id,
      destination_domain: req.destination_domain_id.toString(),
      custom_hook_id: req.custom_hook_id,
      custom_hook_metadata: req.custom_hook_metadata,
    });
    assert(
      gas_payment[0],
      `found no quote for token id ${req.token_id} and destination domain ${req.destination_domain_id}`,
    );

    return {
      denom: gas_payment[0].denom,
      amount: BigInt(gas_payment[0].amount),
    };
  }

  // ### POPULATE CORE ###

  async populateCreateMailbox(
    req: MultiVM.ReqCreateMailbox,
  ): Promise<MsgCreateMailboxEncodeObject> {
    return {
      typeUrl: R.MsgCreateMailbox.proto.type,
      value: R.MsgCreateMailbox.proto.converter.create({
        local_domain: req.domain_id,
        owner: req.signer,
      }),
    };
  }

  async populateSetDefaultIsm(
    req: MultiVM.ReqSetDefaultIsm,
  ): Promise<MsgSetMailboxEncodeObject> {
    return {
      typeUrl: R.MsgSetMailbox.proto.type,
      value: R.MsgSetMailbox.proto.converter.create({
        mailbox_id: req.mailbox_id,
        default_ism: req.ism_id,
        owner: req.signer,
      }),
    };
  }

  async populateSetDefaultHook(
    req: MultiVM.ReqSetDefaultHook,
  ): Promise<MsgSetMailboxEncodeObject> {
    return {
      typeUrl: R.MsgSetMailbox.proto.type,
      value: R.MsgSetMailbox.proto.converter.create({
        mailbox_id: req.mailbox_id,
        default_hook: req.hook_id,
        owner: req.signer,
      }),
    };
  }

  async populateSetRequiredHook(
    req: MultiVM.ReqSetRequiredHook,
  ): Promise<MsgSetMailboxEncodeObject> {
    return {
      typeUrl: R.MsgSetMailbox.proto.type,
      value: R.MsgSetMailbox.proto.converter.create({
        mailbox_id: req.mailbox_id,
        required_hook: req.hook_id,
        owner: req.signer,
      }),
    };
  }

  async populateSetMailboxOwner(
    req: MultiVM.ReqSetMailboxOwner,
  ): Promise<MsgSetMailboxEncodeObject> {
    return {
      typeUrl: R.MsgSetMailbox.proto.type,
      value: R.MsgSetMailbox.proto.converter.create({
        new_owner: req.new_owner,
        renounce_ownership: !req.new_owner,
        owner: req.signer,
      }),
    };
  }

  async populateCreateMerkleRootMultisigIsm(
    req: MultiVM.ReqCreateMerkleRootMultisigIsm,
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
    req: MultiVM.ReqCreateMessageIdMultisigIsm,
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
    req: MultiVM.ReqCreateRoutingIsm,
  ): Promise<MsgCreateRoutingIsmEncodeObject> {
    return {
      typeUrl: R.MsgCreateRoutingIsm.proto.type,
      value: R.MsgCreateRoutingIsm.proto.converter.create({
        creator: req.signer,
        routes: req.routes.map((r) => ({ domain: r.domain_id, ism: r.ism })),
      }),
    };
  }

  async populateSetRoutingIsmRoute(
    req: MultiVM.ReqSetRoutingIsmRoute,
  ): Promise<MsgSetRoutingIsmDomainEncodeObject> {
    return {
      typeUrl: R.MsgSetRoutingIsmDomain.proto.type,
      value: R.MsgSetRoutingIsmDomain.proto.converter.create({
        owner: req.signer,
        ism_id: req.ism_id,
        route: {
          domain: req.route.domain_id,
          ism: req.route.ism_id,
        },
      }),
    };
  }

  async populateRemoveRoutingIsmRoute(
    req: MultiVM.ReqRemoveRoutingIsmRoute,
  ): Promise<MsgRemoveRoutingIsmDomainEncodeObject> {
    return {
      typeUrl: R.MsgRemoveRoutingIsmDomain.proto.type,
      value: R.MsgRemoveRoutingIsmDomain.proto.converter.create({
        owner: req.signer,
        ism_id: req.ism_id,
        domain: req.domain_id,
      }),
    };
  }

  async populateSetRoutingIsmOwner(
    req: MultiVM.ReqSetRoutingIsmOwner,
  ): Promise<any> {
    return {
      typeUrl: R.MsgUpdateRoutingIsmOwner.proto.type,
      value: R.MsgUpdateRoutingIsmOwner.proto.converter.create({
        owner: req.signer,
        new_owner: req.new_owner,
        renounce_ownership: !req.new_owner,
      }),
    };
  }

  async populateCreateNoopIsm(
    req: MultiVM.ReqCreateNoopIsm,
  ): Promise<MsgCreateNoopIsmEncodeObject> {
    return {
      typeUrl: R.MsgCreateNoopIsm.proto.type,
      value: R.MsgCreateNoopIsm.proto.converter.create({
        creator: req.signer,
      }),
    };
  }

  async populateCreateMerkleTreeHook(
    req: MultiVM.ReqCreateMerkleTreeHook,
  ): Promise<MsgCreateMerkleTreeHookEncodeObject> {
    return {
      typeUrl: R.MsgCreateMerkleTreeHook.proto.type,
      value: R.MsgCreateMerkleTreeHook.proto.converter.create({
        owner: req.signer,
        mailbox_id: req.mailbox_id,
      }),
    };
  }

  async populateCreateInterchainGasPaymasterHook(
    req: MultiVM.ReqCreateInterchainGasPaymasterHook,
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
    req: MultiVM.ReqSetInterchainGasPaymasterHookOwner,
  ): Promise<MsgSetIgpOwnerEncodeObject> {
    return {
      typeUrl: R.MsgSetIgpOwner.proto.type,
      value: R.MsgSetIgpOwner.proto.converter.create({
        owner: req.signer,
        new_owner: req.new_owner,
        renounce_ownership: !req.new_owner,
      }),
    };
  }

  async populateSetDestinationGasConfig(
    req: MultiVM.ReqSetDestinationGasConfig,
  ): Promise<MsgSetDestinationGasConfigEncodeObject> {
    return {
      typeUrl: R.MsgSetDestinationGasConfig.proto.type,
      value: R.MsgSetDestinationGasConfig.proto.converter.create({
        owner: req.signer,
        igp_id: req.hook_id,
        destination_gas_config: {
          remote_domain: req.destination_gas_config.remote_domain_id,
          gas_overhead: req.destination_gas_config.gas_overhead,
          gas_oracle: req.destination_gas_config.gas_oracle,
        },
      }),
    };
  }

  async populateCreateValidatorAnnounce(
    _req: MultiVM.ReqCreateValidatorAnnounce,
  ): Promise<any> {
    throw new Error(
      'Cosmos Native does not support populateCreateValidatorAnnounce',
    );
  }

  // ### POPULATE WARP ###

  async populateCreateCollateralToken(
    req: MultiVM.ReqCreateCollateralToken,
  ): Promise<MsgCreateCollateralTokenEncodeObject> {
    return {
      typeUrl: R.MsgCreateCollateralToken.proto.type,
      value: R.MsgCreateCollateralToken.proto.converter.create({
        owner: req.signer,
        origin_mailbox: req.mailbox_id,
        origin_denom: req.origin_denom,
      }),
    };
  }

  async populateCreateSyntheticToken(
    req: MultiVM.ReqCreateSyntheticToken,
  ): Promise<MsgCreateSyntheticTokenEncodeObject> {
    return {
      typeUrl: R.MsgCreateSyntheticToken.proto.type,
      value: R.MsgCreateSyntheticToken.proto.converter.create({
        owner: req.signer,
        origin_mailbox: req.mailbox_id,
      }),
    };
  }

  async populateSetTokenOwner(
    req: MultiVM.ReqSetTokenOwner,
  ): Promise<MsgSetTokenEncodeObject> {
    return {
      typeUrl: R.MsgSetToken.proto.type,
      value: R.MsgSetToken.proto.converter.create({
        owner: req.signer,
        token_id: req.token_id,
        new_owner: req.new_owner,
        renounce_ownership: !req.new_owner,
      }),
    };
  }

  async populateSetTokenIsm(
    req: MultiVM.ReqSetTokenIsm,
  ): Promise<MsgSetTokenEncodeObject> {
    return {
      typeUrl: R.MsgSetToken.proto.type,
      value: R.MsgSetToken.proto.converter.create({
        owner: req.signer,
        token_id: req.token_id,
        ism_id: req.ism_id,
      }),
    };
  }

  async populateEnrollRemoteRouter(
    req: MultiVM.ReqEnrollRemoteRouter,
  ): Promise<MsgEnrollRemoteRouterEncodeObject> {
    return {
      typeUrl: R.MsgEnrollRemoteRouter.proto.type,
      value: R.MsgEnrollRemoteRouter.proto.converter.create({
        owner: req.signer,
        token_id: req.token_id,
        remote_router: {
          receiver_domain: req.receiver_domain_id,
          receiver_contract: req.receiver_address,
          gas: req.gas,
        },
      }),
    };
  }

  async populateUnenrollRemoteRouter(
    req: MultiVM.ReqUnenrollRemoteRouter,
  ): Promise<MsgUnrollRemoteRouterEncodeObject> {
    return {
      typeUrl: R.MsgUnrollRemoteRouter.proto.type,
      value: R.MsgUnrollRemoteRouter.proto.converter.create({
        owner: req.signer,
        token_id: req.token_id,
        receiver_domain: req.receiver_domain_id,
      }),
    };
  }

  async populateRemoteTransfer(
    req: MultiVM.ReqRemoteTransfer,
  ): Promise<MsgRemoteTransferEncodeObject> {
    return {
      typeUrl: R.MsgRemoteTransfer.proto.type,
      value: R.MsgRemoteTransfer.proto.converter.create({
        sender: req.signer,
        token_id: req.token_id,
        destination_domain: req.destination_domain_id,
        recipient: req.recipient,
        amount: req.amount,
        custom_hook_id: req.custom_hook_id,
        gas_limit: req.gas_limit,
        max_fee: req.max_fee,
        custom_hook_metadata: req.custom_hook_metadata,
      }),
    };
  }
}
