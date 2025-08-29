import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';
import { NetworkId } from '@radixdlt/radix-engine-toolkit';
import { utils } from 'ethers';

import { assert, strip0x } from '@hyperlane-xyz/utils';

import { RadixCorePopulate } from './core/populate.js';
import { RadixCoreQuery } from './core/query.js';
import { RadixCoreTx } from './core/tx.js';
import { RadixBase } from './utils/base.js';
import { RadixSigner } from './utils/signer.js';
import { Account, RadixSDKOptions } from './utils/types.js';
import { generateNewEd25519VirtualAccount } from './utils/utils.js';
import { RadixWarpPopulate } from './warp/populate.js';
import { RadixWarpQuery } from './warp/query.js';
import { RadixWarpTx } from './warp/tx.js';

const NETWORKS = {
  [NetworkId.Stokenet]: {
    applicationName: 'hyperlane',
    packageAddress:
      'package_tdx_2_1pkn2zdcw8q8rax6mxetdkgp7493mf379afhq7a7peh4wnftz3zej4h',
  },
  [NetworkId.Mainnet]: {
    applicationName: 'hyperlane',
    packageAddress:
      'package_rdx1pk3ldj3ktxuw6sv5txspjt2a8s42c7xxcn6wnf5yuytdrcqhpflfkc',
  },
};

export { NetworkId };

export const DEFAULT_GAS_MULTIPLIER = 1.2;

export class RadixSDK {
  protected networkId: number;
  protected gateway: GatewayApiClient;

  public applicationName: string;
  public packageAddress: string;

  public base: RadixBase;
  public query: {
    core: RadixCoreQuery;
    warp: RadixWarpQuery;
  };
  public populate: {
    core: RadixCorePopulate;
    warp: RadixWarpPopulate;
  };

  constructor(options?: RadixSDKOptions) {
    this.networkId = options?.networkId ?? NetworkId.Mainnet;

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
      options?.gasMultiplier ?? DEFAULT_GAS_MULTIPLIER,
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

  public getNetworkId() {
    return this.networkId;
  }
}

export class RadixSigningSDK extends RadixSDK {
  private account: Account;

  public tx: {
    core: RadixCoreTx;
    warp: RadixWarpTx;
  };
  public signer: RadixSigner;

  private constructor(account: Account, options?: RadixSDKOptions) {
    super(options);

    this.account = account;
    this.signer = new RadixSigner(
      this.networkId,
      this.gateway,
      this.base,
      this.account,
    );
    this.tx = {
      core: new RadixCoreTx(
        account,
        this.base,
        this.signer,
        this.populate.core,
      ),
      warp: new RadixWarpTx(
        account,
        this.base,
        this.signer,
        this.populate.warp,
      ),
    };
  }

  public getAddress() {
    return this.account.address;
  }

  public static async fromRandomPrivateKey(options?: RadixSDKOptions) {
    const privateKey = Buffer.from(utils.randomBytes(32)).toString('hex');
    const account = await generateNewEd25519VirtualAccount(
      privateKey,
      options?.networkId ?? NetworkId.Mainnet,
    );
    return new RadixSigningSDK(account, options);
  }

  public static async fromPrivateKey(
    privateKey: string,
    options?: RadixSDKOptions,
  ) {
    const account = await generateNewEd25519VirtualAccount(
      strip0x(privateKey),
      options?.networkId ?? NetworkId.Mainnet,
    );
    return new RadixSigningSDK(account, options);
  }
}
