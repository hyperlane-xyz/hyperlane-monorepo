import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';
import { NetworkId } from '@radixdlt/radix-engine-toolkit';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import type { ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk/chain';
import {
  composeWarpDeployGas,
  type WarpArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/warp';
import { assert } from '@hyperlane-xyz/utils';

import { isMessageDelivered } from '../mailbox/mailbox-query.js';
import { RadixBase } from '../utils/base.js';
import { RadixSDKOptions, RadixSDKTransaction } from '../utils/types.js';
import { RadixWarpPopulate } from '../warp/populate.js';
import { RadixWarpQuery } from '../warp/query.js';

const DEFAULT_GAS_MULTIPLIER = 1.2;

// Warp-deploy cost breakdown for Radix. Composed additively in
// getMinGasForWarpDeploy() based on the WarpConfig shape. Values are native
// denom (XRD, 18 decimals).
//
// The base is a devnet-observed base-router deploy floor with safety margin;
// mainnet gas prices differ, so treat it as a lower-bound advisory. Per-feature
// deltas stay 0n pending measured feature-heavy deploys.
const WARP_DEPLOY_BASE_XRD = 7_000_000_000_000_000_000n; // 7 XRD base router deploy
const WARP_DEPLOY_CROSS_COLLATERAL_EXTRA_XRD = 0n;
const WARP_DEPLOY_FEE_PROGRAM_XRD = 0n;
const WARP_DEPLOY_CUSTOM_ISM_XRD = 0n;
const WARP_DEPLOY_CUSTOM_HOOK_XRD = 0n;

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
  protected chainMetadata: ChainMetadataForAltVM;
  protected query: {
    warp: RadixWarpQuery;
  };
  protected populate: {
    warp: RadixWarpPopulate;
  };

  async getMinGasForWarpDeploy(
    warpConfig: WarpArtifactConfig,
  ): Promise<bigint> {
    return composeWarpDeployGas(warpConfig, {
      base: WARP_DEPLOY_BASE_XRD,
      crossCollateralExtra: WARP_DEPLOY_CROSS_COLLATERAL_EXTRA_XRD,
      feeProgram: WARP_DEPLOY_FEE_PROGRAM_XRD,
      customIsm: WARP_DEPLOY_CUSTOM_ISM_XRD,
      customHook: WARP_DEPLOY_CUSTOM_HOOK_XRD,
    });
  }

  static async connect(
    metadata: ChainMetadataForAltVM,
  ): Promise<RadixProvider> {
    const networkId = parseInt(metadata.chainId.toString());
    const rpcUrls = (metadata.rpcUrls ?? []).map(({ http }) => http);

    return new RadixProvider({
      rpcUrls,
      networkId,
      gatewayUrls: metadata.gatewayUrls?.map(({ http }) => http),
      packageAddress: metadata.packageAddress,
      chainMetadata: metadata,
    });
  }

  constructor(options: RadixSDKOptions) {
    this.rpcUrls = options.rpcUrls;
    this.chainMetadata = options.chainMetadata;
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

  async isMessageDelivered(req: AltVM.ReqIsMessageDelivered): Promise<boolean> {
    return isMessageDelivered(this.gateway, req.mailboxAddress, req.messageId);
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
