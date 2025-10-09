import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';
import { NetworkId } from '@radixdlt/radix-engine-toolkit';

import { AltVM, assert } from '@hyperlane-xyz/utils';

import { RadixCorePopulate } from '../core/populate.js';
import { RadixCoreQuery } from '../core/query.js';
import { RadixBase } from '../utils/base.js';
import {
  RadixHookTypes,
  RadixIsmTypes,
  RadixSDKOptions,
  RadixSDKTransaction,
} from '../utils/types.js';
import { stringToTransactionManifest } from '../utils/utils.js';
import { RadixWarpPopulate } from '../warp/populate.js';
import { RadixWarpQuery } from '../warp/query.js';

const DEFAULT_GAS_MULTIPLIER = 1.2;

const NETWORKS = {
  [NetworkId.Stokenet]: {
    applicationName: 'hyperlane',
    packageAddress:
      'package_tdx_2_1pkn2zdcw8q8rax6mxetdkgp7493mf379afhq7a7peh4wnftz3zej4h',
  },
  [NetworkId.Mainnet]: {
    applicationName: 'hyperlane',
    packageAddress:
      'package_rdx1pkzmcj4mtal34ddx9jrt8um6u3yqheqpfvcj4s0ulmgyt094fw0jzh',
  },
};

export class RadixProvider implements AltVM.IProvider<RadixSDKTransaction> {
  protected rpcUrls: string[];
  protected networkId: number;
  protected gateway: GatewayApiClient;

  protected applicationName: string;
  protected packageAddress: string;

  protected base: RadixBase;
  protected query: {
    core: RadixCoreQuery;
    warp: RadixWarpQuery;
  };
  protected populate: {
    core: RadixCorePopulate;
    warp: RadixWarpPopulate;
  };

  static async connect(
    rpcUrls: string[],
    chainId: string | number,
  ): Promise<RadixProvider> {
    const networkId = parseInt(chainId.toString());

    return new RadixProvider({
      rpcUrls,
      networkId,
    });
  }

  constructor(options: RadixSDKOptions) {
    this.rpcUrls = options.rpcUrls;
    this.networkId = options.networkId ?? NetworkId.Mainnet;

    assert(
      NETWORKS[this.networkId],
      `Network with id ${this.networkId} not supported with the Hyperlane RadixSDK. Supported network ids: ${Object.keys(NETWORKS).join(', ')}`,
    );

    this.applicationName = NETWORKS[this.networkId].applicationName;
    this.packageAddress = NETWORKS[this.networkId].packageAddress;

    this.gateway = GatewayApiClient.initialize({
      applicationName: this.applicationName,
      networkId: this.networkId,
    });

    this.base = new RadixBase(
      this.networkId,
      this.gateway,
      options.gasMultiplier ?? DEFAULT_GAS_MULTIPLIER,
    );

    this.query = {
      core: new RadixCoreQuery(this.networkId, this.gateway, this.base),
      warp: new RadixWarpQuery(this.networkId, this.gateway, this.base),
    };

    this.populate = {
      core: new RadixCorePopulate(this.gateway, this.base, this.packageAddress),
      warp: new RadixWarpPopulate(
        this.gateway,
        this.base,
        this.query.warp,
        this.packageAddress,
      ),
    };
  }

  // ### QUERY BASE ###

  async isHealthy() {
    return this.base.isGatewayHealthy();
  }

  getRpcUrls(): string[] {
    return this.rpcUrls;
  }

  async getHeight(): Promise<number> {
    return this.base.getHeight();
  }

  async getBalance(req: AltVM.ReqGetBalance): Promise<bigint> {
    return this.base.getBalance({
      address: req.address,
      resource: req.denom,
    });
  }

  async getTotalSupply(req: AltVM.ReqGetTotalSupply): Promise<bigint> {
    return this.base.getTotalSupply({
      resource: req.denom,
    });
  }

  async estimateTransactionFee(
    req: AltVM.ReqEstimateTransactionFee<RadixSDKTransaction>,
  ): Promise<AltVM.ResEstimateTransactionFee> {
    return this.base.estimateTransactionFee({
      transactionManifest: req.transaction.manifest,
    });
  }

  // ### QUERY CORE ###

  async getMailbox(req: AltVM.ReqGetMailbox): Promise<AltVM.ResGetMailbox> {
    return this.query.core.getMailbox({ mailbox: req.mailboxAddress });
  }

  async isMessageDelivered(req: AltVM.ReqIsMessageDelivered): Promise<boolean> {
    try {
      await this.base.pollForCommit(req.messageId);
      return true;
    } catch {
      return true;
    }
  }

  async getIsmType(req: AltVM.ReqGetIsmType): Promise<AltVM.IsmType> {
    const ismType = await this.query.core.getIsmType({
      ism: req.ismAddress,
    });

    switch (ismType) {
      case RadixIsmTypes.MERKLE_ROOT_MULTISIG: {
        return AltVM.IsmType.MERKLE_ROOT_MULTISIG;
      }
      case RadixIsmTypes.MESSAGE_ID_MULTISIG: {
        return AltVM.IsmType.MESSAGE_ID_MULTISIG;
      }
      case RadixIsmTypes.ROUTING_ISM: {
        return AltVM.IsmType.ROUTING;
      }
      case RadixIsmTypes.NOOP_ISM: {
        return AltVM.IsmType.TEST_ISM;
      }
      default:
        throw new Error(`Unknown ISM ModuleType: ${ismType}`);
    }
  }

  async getMessageIdMultisigIsm(
    req: AltVM.ReqMessageIdMultisigIsm,
  ): Promise<AltVM.ResMessageIdMultisigIsm> {
    const ism = await this.query.core.getMultisigIsm({ ism: req.ismAddress });

    assert(
      ism.type === RadixIsmTypes.MESSAGE_ID_MULTISIG,
      `ism with address ${req.ismAddress} is no ${RadixIsmTypes.MESSAGE_ID_MULTISIG}`,
    );

    return {
      address: ism.address,
      validators: ism.validators,
      threshold: ism.threshold,
    };
  }

  async getMerkleRootMultisigIsm(
    req: AltVM.ReqMerkleRootMultisigIsm,
  ): Promise<AltVM.ResMerkleRootMultisigIsm> {
    const ism = await this.query.core.getMultisigIsm({ ism: req.ismAddress });

    assert(
      ism.type === RadixIsmTypes.MERKLE_ROOT_MULTISIG,
      `ism with address ${req.ismAddress} is no ${RadixIsmTypes.MERKLE_ROOT_MULTISIG}`,
    );

    return {
      address: ism.address,
      validators: ism.validators,
      threshold: ism.threshold,
    };
  }

  async getRoutingIsm(req: AltVM.ReqRoutingIsm): Promise<AltVM.ResRoutingIsm> {
    return this.query.core.getRoutingIsm({
      ism: req.ismAddress,
    });
  }

  async getNoopIsm(req: AltVM.ReqNoopIsm): Promise<AltVM.ResNoopIsm> {
    const ism = await this.query.core.getMultisigIsm({ ism: req.ismAddress });

    assert(
      ism.type === RadixIsmTypes.NOOP_ISM,
      `ism with address ${req.ismAddress} is no ${RadixIsmTypes.NOOP_ISM}`,
    );

    return {
      address: req.ismAddress,
    };
  }

  async getHookType(req: AltVM.ReqGetHookType): Promise<AltVM.HookType> {
    const hookType = await this.query.core.getHookType({
      hook: req.hookAddress,
    });

    switch (hookType) {
      case RadixHookTypes.IGP: {
        return AltVM.HookType.INTERCHAIN_GAS_PAYMASTER;
      }
      case RadixHookTypes.MERKLE_TREE: {
        return AltVM.HookType.MERKLE_TREE;
      }
      default:
        throw new Error(`Unknown Hook Type: ${hookType}`);
    }
  }

  async getInterchainGasPaymasterHook(
    req: AltVM.ReqGetInterchainGasPaymasterHook,
  ): Promise<AltVM.ResGetInterchainGasPaymasterHook> {
    return this.query.core.getIgpHook({ hook: req.hookAddress });
  }

  async getMerkleTreeHook(
    req: AltVM.ReqGetMerkleTreeHook,
  ): Promise<AltVM.ResGetMerkleTreeHook> {
    return this.query.core.getMerkleTreeHook({ hook: req.hookAddress });
  }

  // ### QUERY WARP ###

  async getToken(req: AltVM.ReqGetToken): Promise<AltVM.ResGetToken> {
    const token = await this.query.warp.getToken({ token: req.tokenAddress });

    switch (token.tokenType) {
      case 'Collateral':
        return {
          ...token,
          tokenType: AltVM.TokenType.collateral,
        };
      case 'Synthetic':
        return {
          ...token,
          tokenType: AltVM.TokenType.synthetic,
        };
      default:
        throw new Error(`Unknown Token Type: ${token.tokenType}`);
    }
  }

  async getRemoteRouters(
    req: AltVM.ReqGetRemoteRouters,
  ): Promise<AltVM.ResGetRemoteRouters> {
    return this.query.warp.getRemoteRouters({ token: req.tokenAddress });
  }

  async getBridgedSupply(req: AltVM.ReqGetBridgedSupply): Promise<bigint> {
    return this.query.warp.getBridgedSupply({ token: req.tokenAddress });
  }

  async quoteRemoteTransfer(
    req: AltVM.ReqQuoteRemoteTransfer,
  ): Promise<AltVM.ResQuoteRemoteTransfer> {
    return this.query.warp.quoteRemoteTransfer({
      token: req.tokenAddress,
      destination_domain: req.destinationDomainId,
    });
  }

  // ### GET CORE TXS ###

  async getCreateMailboxTransaction(
    req: AltVM.ReqCreateMailbox,
  ): Promise<RadixSDKTransaction> {
    return {
      networkId: this.networkId,
      manifest: await this.populate.core.createMailbox({
        from_address: req.signer,
        domain_id: req.domainId,
      }),
    };
  }

  async getSetDefaultIsmTransaction(
    req: AltVM.ReqSetDefaultIsm,
  ): Promise<RadixSDKTransaction> {
    return {
      networkId: this.networkId,
      manifest: await this.populate.core.setDefaultIsm({
        from_address: req.signer,
        mailbox: req.mailboxAddress,
        ism: req.ismAddress,
      }),
    };
  }

  async getSetDefaultHookTransaction(
    req: AltVM.ReqSetDefaultHook,
  ): Promise<RadixSDKTransaction> {
    return {
      networkId: this.networkId,
      manifest: await this.populate.core.setDefaultHook({
        from_address: req.signer,
        mailbox: req.mailboxAddress,
        hook: req.hookAddress,
      }),
    };
  }

  async getSetRequiredHookTransaction(
    req: AltVM.ReqSetRequiredHook,
  ): Promise<RadixSDKTransaction> {
    return {
      networkId: this.networkId,
      manifest: await this.populate.core.setRequiredHook({
        from_address: req.signer,
        mailbox: req.mailboxAddress,
        hook: req.hookAddress,
      }),
    };
  }

  async getSetMailboxOwnerTransaction(
    req: AltVM.ReqSetMailboxOwner,
  ): Promise<RadixSDKTransaction> {
    return {
      networkId: this.networkId,
      manifest: await this.populate.core.setMailboxOwner({
        from_address: req.signer,
        mailbox: req.mailboxAddress,
        new_owner: req.newOwner,
      }),
    };
  }

  async getCreateMerkleRootMultisigIsmTransaction(
    req: AltVM.ReqCreateMerkleRootMultisigIsm,
  ): Promise<RadixSDKTransaction> {
    return {
      networkId: this.networkId,
      manifest: await this.populate.core.createMerkleRootMultisigIsm({
        from_address: req.signer,
        validators: req.validators,
        threshold: req.threshold,
      }),
    };
  }

  async getCreateMessageIdMultisigIsmTransaction(
    req: AltVM.ReqCreateMessageIdMultisigIsm,
  ): Promise<RadixSDKTransaction> {
    return {
      networkId: this.networkId,
      manifest: await this.populate.core.createMessageIdMultisigIsm({
        from_address: req.signer,
        validators: req.validators,
        threshold: req.threshold,
      }),
    };
  }

  async getCreateRoutingIsmTransaction(
    req: AltVM.ReqCreateRoutingIsm,
  ): Promise<RadixSDKTransaction> {
    return {
      networkId: this.networkId,
      manifest: await this.populate.core.createRoutingIsm({
        from_address: req.signer,
        routes: req.routes,
      }),
    };
  }

  async getSetRoutingIsmRouteTransaction(
    req: AltVM.ReqSetRoutingIsmRoute,
  ): Promise<RadixSDKTransaction> {
    return {
      networkId: this.networkId,
      manifest: await this.populate.core.setRoutingIsmRoute({
        from_address: req.signer,
        ism: req.ismAddress,
        route: req.route,
      }),
    };
  }

  async getRemoveRoutingIsmRouteTransaction(
    req: AltVM.ReqRemoveRoutingIsmRoute,
  ): Promise<RadixSDKTransaction> {
    return {
      networkId: this.networkId,
      manifest: await this.populate.core.removeRoutingIsmRoute({
        from_address: req.signer,
        ism: req.ismAddress,
        domain: req.domainId,
      }),
    };
  }

  async getSetRoutingIsmOwnerTransaction(
    req: AltVM.ReqSetRoutingIsmOwner,
  ): Promise<RadixSDKTransaction> {
    return {
      networkId: this.networkId,
      manifest: await this.populate.core.setRoutingIsmOwner({
        from_address: req.signer,
        ism: req.ismAddress,
        new_owner: req.newOwner,
      }),
    };
  }

  async getCreateNoopIsmTransaction(
    req: AltVM.ReqCreateNoopIsm,
  ): Promise<RadixSDKTransaction> {
    return {
      networkId: this.networkId,
      manifest: await this.populate.core.createNoopIsm({
        from_address: req.signer,
      }),
    };
  }

  async getCreateMerkleTreeHookTransaction(
    req: AltVM.ReqCreateMerkleTreeHook,
  ): Promise<RadixSDKTransaction> {
    return {
      networkId: this.networkId,
      manifest: await this.populate.core.createMerkleTreeHook({
        from_address: req.signer,
        mailbox: req.mailboxAddress,
      }),
    };
  }

  async getCreateInterchainGasPaymasterHookTransaction(
    req: AltVM.ReqCreateInterchainGasPaymasterHook,
  ): Promise<RadixSDKTransaction> {
    return {
      networkId: this.networkId,
      manifest: await this.populate.core.createIgp({
        from_address: req.signer,
        denom: req.denom,
      }),
    };
  }

  async getSetInterchainGasPaymasterHookOwnerTransaction(
    req: AltVM.ReqSetInterchainGasPaymasterHookOwner,
  ): Promise<RadixSDKTransaction> {
    return {
      networkId: this.networkId,
      manifest: await this.populate.core.setIgpOwner({
        from_address: req.signer,
        igp: req.hookAddress,
        new_owner: req.newOwner,
      }),
    };
  }

  async getSetDestinationGasConfigTransaction(
    req: AltVM.ReqSetDestinationGasConfig,
  ): Promise<RadixSDKTransaction> {
    return {
      networkId: this.networkId,
      manifest: await this.populate.core.setDestinationGasConfig({
        from_address: req.signer,
        igp: req.hookAddress,
        destinationGasConfig: req.destinationGasConfig,
      }),
    };
  }

  async getCreateValidatorAnnounceTransaction(
    req: AltVM.ReqCreateValidatorAnnounce,
  ): Promise<RadixSDKTransaction> {
    return {
      networkId: this.networkId,
      manifest: await this.populate.core.createValidatorAnnounce({
        from_address: req.signer,
        mailbox: req.mailboxAddress,
      }),
    };
  }

  // ### GET WARP TXS ###

  async getCreateCollateralTokenTransaction(
    req: AltVM.ReqCreateCollateralToken,
  ): Promise<RadixSDKTransaction> {
    return {
      networkId: this.networkId,
      manifest: await this.populate.warp.createCollateralToken({
        from_address: req.signer,
        mailbox: req.mailboxAddress,
        origin_denom: req.collateralDenom,
      }),
    };
  }

  async getCreateSyntheticTokenTransaction(
    req: AltVM.ReqCreateSyntheticToken,
  ): Promise<RadixSDKTransaction> {
    return {
      networkId: this.networkId,
      manifest: await this.populate.warp.createSyntheticToken({
        from_address: req.signer,
        mailbox: req.mailboxAddress,
        name: req.name,
        symbol: req.denom,
        divisibility: req.decimals,
      }),
    };
  }

  async getSetTokenOwnerTransaction(
    req: AltVM.ReqSetTokenOwner,
  ): Promise<RadixSDKTransaction> {
    return {
      networkId: this.networkId,
      manifest: await this.populate.warp.setTokenOwner({
        from_address: req.signer,
        token: req.tokenAddress,
        new_owner: req.newOwner,
      }),
    };
  }

  async getSetTokenIsmTransaction(
    req: AltVM.ReqSetTokenIsm,
  ): Promise<RadixSDKTransaction> {
    return {
      networkId: this.networkId,
      manifest: await this.populate.warp.setTokenIsm({
        from_address: req.signer,
        token: req.tokenAddress,
        ism: req.ismAddress,
      }),
    };
  }

  async getEnrollRemoteRouterTransaction(
    req: AltVM.ReqEnrollRemoteRouter,
  ): Promise<RadixSDKTransaction> {
    return {
      networkId: this.networkId,
      manifest: await this.populate.warp.enrollRemoteRouter({
        from_address: req.signer,
        token: req.tokenAddress,
        receiver_domain: req.remoteRouter.receiverDomainId,
        receiver_address: req.remoteRouter.receiverAddress,
        gas: req.remoteRouter.gas,
      }),
    };
  }

  async getUnenrollRemoteRouterTransaction(
    req: AltVM.ReqUnenrollRemoteRouter,
  ): Promise<RadixSDKTransaction> {
    return {
      networkId: this.networkId,
      manifest: await this.populate.warp.unenrollRemoteRouter({
        from_address: req.signer,
        token: req.tokenAddress,
        receiver_domain: req.receiverDomainId,
      }),
    };
  }

  async getTransferTransaction(
    req: AltVM.ReqTransfer,
  ): Promise<RadixSDKTransaction> {
    return {
      networkId: this.networkId,
      manifest: await this.base.transfer({
        from_address: req.signer,
        to_address: req.recipient,
        amount: req.amount,
        resource_address: req.denom,
      }),
    };
  }

  async getRemoteTransferTransaction(
    req: AltVM.ReqRemoteTransfer,
  ): Promise<RadixSDKTransaction> {
    const manifest = await this.populate.warp.remoteTransfer({
      from_address: req.signer,
      token: req.tokenAddress,
      destination_domain: req.destinationDomainId,
      recipient: req.recipient,
      amount: req.amount,
      custom_hook_id: req.customHookAddress || '',
      gas_limit: req.gasLimit,
      custom_hook_metadata: req.customHookMetadata || '',
      max_fee: {
        amount: req.maxFee.amount,
        denom: req.maxFee.denom,
      },
    });

    return {
      networkId: this.networkId,
      manifest: await stringToTransactionManifest(manifest, this.networkId),
    };
  }
}
