import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';
import { NetworkId } from '@radixdlt/radix-engine-toolkit';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { assert } from '@hyperlane-xyz/utils';

import { DEFAULT_APPLICATION_NAME, DEFAULT_GAS_MULTIPLIER } from '../const.js';
import { RadixCorePopulate } from '../core/populate.js';
import { RadixCoreQuery } from '../core/query.js';
import { RadixBase } from '../utils/base.js';
import {
  RadixHookTypes,
  RadixIsmTypes,
  RadixSDKOptions,
  RadixSDKTransaction,
  ismTypeFromRadixIsmType,
} from '../utils/types.js';
import { RadixWarpPopulate } from '../warp/populate.js';
import { RadixWarpQuery } from '../warp/query.js';

const NETWORKS = {
  [NetworkId.Stokenet]: {
    applicationName: DEFAULT_APPLICATION_NAME,
    packageAddress:
      'package_tdx_2_1pkn2zdcw8q8rax6mxetdkgp7493mf379afhq7a7peh4wnftz3zej4h',
  },
  [NetworkId.Mainnet]: {
    applicationName: DEFAULT_APPLICATION_NAME,
    packageAddress:
      'package_rdx1pkzmcj4mtal34ddx9jrt8um6u3yqheqpfvcj4s0ulmgyt094fw0jzh',
  },
  [NetworkId.LocalNet]: {
    applicationName: DEFAULT_APPLICATION_NAME,
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
    extraParams?: Record<string, any>,
  ): Promise<RadixProvider> {
    const networkId = parseInt(chainId.toString());

    return new RadixProvider({
      rpcUrls,
      networkId,
      gatewayUrls: (
        extraParams?.metadata?.gatewayUrls as { http: string }[]
      )?.map(({ http }) => http),
      packageAddress: extraParams?.metadata?.packageAddress,
    });
  }

  constructor(options: RadixSDKOptions) {
    this.rpcUrls = options.rpcUrls;
    this.networkId = options.networkId ?? NetworkId.Mainnet;

    const networkBaseConfig = NETWORKS[this.networkId];
    assert(
      networkBaseConfig,
      `Network with id ${this.networkId} not supported with the Hyperlane RadixSDK. Supported network ids: ${Object.keys(NETWORKS).join(', ')}`,
    );

    this.applicationName = networkBaseConfig.applicationName;
    const packageAddress =
      options.packageAddress ?? networkBaseConfig.packageAddress;
    assert(
      packageAddress,
      `Expected package address to be defined for radix network with id ${this.networkId}`,
    );
    this.packageAddress = packageAddress;

    this.gateway = GatewayApiClient.initialize({
      applicationName: this.applicationName,
      basePath: options.gatewayUrls?.[0],
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

  // in RadixDLT there are no blocks, but we can use the ledger state version
  // which has a similar concept
  async getHeight(): Promise<number> {
    return this.base.getStateVersion();
  }

  async getBalance(req: AltVM.ReqGetBalance): Promise<bigint> {
    assert(req.denom, `denom required by ${RadixProvider.name}`);

    return this.base.getBalance({
      address: req.address,
      resource: req.denom,
    });
  }

  async getTotalSupply(req: AltVM.ReqGetTotalSupply): Promise<bigint> {
    assert(req.denom, `denom required by ${RadixProvider.name}`);

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
    return this.query.core.isMessageDelivered({
      mailbox: req.mailboxAddress,
      message_id: req.messageId,
    });
  }

  async getIsmType(req: AltVM.ReqGetIsmType): Promise<AltVM.IsmType> {
    const ismType = await this.query.core.getIsmType({
      ism: req.ismAddress,
    });

    return ismTypeFromRadixIsmType(ismType);
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

  async getNoopHook(_req: AltVM.ReqGetNoopHook): Promise<AltVM.ResGetNoopHook> {
    throw new Error(`Noop Hook is currently not supported on Radix`);
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
    assert(req.denom, `denom required by ${RadixProvider.name}`);

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

  async getRemoveDestinationGasConfigTransaction(
    _req: AltVM.ReqRemoveDestinationGasConfig,
  ): Promise<RadixSDKTransaction> {
    throw new Error(
      `RemoveDestinationGasConfig is currently not supported on Radix`,
    );
  }

  async getCreateNoopHookTransaction(
    _req: AltVM.ReqCreateNoopHook,
  ): Promise<RadixSDKTransaction> {
    throw new Error(`CreateNoopHook is currently not supported on Radix`);
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

  async getCreateNativeTokenTransaction(
    _req: AltVM.ReqCreateNativeToken,
  ): Promise<RadixSDKTransaction> {
    throw new Error(`Native Token is not supported on Radix`);
  }

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
    assert(req.denom, `denom required by ${RadixProvider.name}`);

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
    return {
      networkId: this.networkId,
      manifest: await this.populate.warp.remoteTransfer({
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
      }),
    };
  }
}
