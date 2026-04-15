import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';
import { NetworkId } from '@radixdlt/radix-engine-toolkit';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { ZERO_ADDRESS_HEX_32, assert } from '@hyperlane-xyz/utils';

import {
  getHookType,
  getIgpHookConfig,
  getMerkleTreeHookConfig,
} from '../hook/hook-query.js';
import {
  getDomainRoutingIsmConfig,
  getIsmType,
  getMultisigIsmConfig,
  getTestIsmConfig,
} from '../ism/ism-query.js';
import {
  getMailboxConfig,
  isMessageDelivered,
} from '../mailbox/mailbox-query.js';
import { RadixBase } from '../utils/base.js';
import {
  RadixHookTypes,
  RadixIsmTypes,
  RadixSDKOptions,
  RadixSDKTransaction,
} from '../utils/types.js';
import { RadixWarpPopulate } from '../warp/populate.js';
import { RadixWarpQuery } from '../warp/query.js';

const DEFAULT_GAS_MULTIPLIER = 1.2;

type RadixProviderMetadata = {
  chainId?: string | number;
  gatewayUrls?: { http: string }[];
  packageAddress?: string;
};

type RadixConnectionParams = {
  metadata?: RadixProviderMetadata;
};

export const NETWORKS = {
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
  [NetworkId.LocalNet]: {
    applicationName: 'hyperlane',
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
    warp: RadixWarpQuery;
  };
  protected populate: {
    warp: RadixWarpPopulate;
  };

  static async connect(
    rpcUrls: string[],
    chainId: string | number,
    extraParams?: RadixConnectionParams,
  ): Promise<RadixProvider> {
    const networkId = parseInt(chainId.toString());
    const metadata = extraParams?.metadata;
    if (metadata?.chainId != null) {
      const metadataChainId = parseInt(metadata.chainId.toString());
      assert(
        metadataChainId === networkId,
        `mismatched chainId: arg ${chainId} vs metadata ${metadata.chainId}`,
      );
    }

    return new RadixProvider({
      rpcUrls,
      networkId,
      gatewayUrls: metadata?.gatewayUrls?.map(({ http }) => http),
      packageAddress: metadata?.packageAddress,
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
      this.packageAddress,
    );

    this.query = {
      warp: new RadixWarpQuery(this.networkId, this.gateway, this.base),
    };

    this.populate = {
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
    const config = await getMailboxConfig(this.gateway, req.mailboxAddress);
    return {
      ...config,
      defaultIsm: config.defaultIsm ?? ZERO_ADDRESS_HEX_32,
      defaultHook: config.defaultHook ?? ZERO_ADDRESS_HEX_32,
      requiredHook: config.requiredHook ?? ZERO_ADDRESS_HEX_32,
    };
  }

  async isMessageDelivered(req: AltVM.ReqIsMessageDelivered): Promise<boolean> {
    return isMessageDelivered(this.gateway, req.mailboxAddress, req.messageId);
  }

  async getIsmType(req: AltVM.ReqGetIsmType): Promise<AltVM.IsmType> {
    const ismType = await getIsmType(this.gateway, req.ismAddress);

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
    const ism = await getMultisigIsmConfig(this.gateway, req.ismAddress);
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
    const ism = await getMultisigIsmConfig(this.gateway, req.ismAddress);
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
    const ism = await getDomainRoutingIsmConfig(this.gateway, req.ismAddress);

    return {
      address: ism.address,
      owner: ism.owner,
      routes: ism.routes,
    };
  }

  async getNoopIsm(req: AltVM.ReqNoopIsm): Promise<AltVM.ResNoopIsm> {
    const ism = await getTestIsmConfig(this.gateway, req.ismAddress);

    return {
      address: ism.address,
    };
  }

  async getHookType(req: AltVM.ReqGetHookType): Promise<AltVM.HookType> {
    const hookType = await getHookType(this.gateway, req.hookAddress);

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
    const { address, destinationGasConfigs, owner } = await getIgpHookConfig(
      this.gateway,
      req.hookAddress,
    );

    return {
      address,
      destinationGasConfigs,
      owner,
    };
  }

  async getMerkleTreeHook(
    req: AltVM.ReqGetMerkleTreeHook,
  ): Promise<AltVM.ResGetMerkleTreeHook> {
    const { address } = await getMerkleTreeHookConfig(
      this.gateway,
      req.hookAddress,
    );

    return {
      address,
    };
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
