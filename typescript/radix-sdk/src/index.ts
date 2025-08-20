import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';
import { NetworkId } from '@radixdlt/radix-engine-toolkit';
import { randomBytes } from 'crypto';

import { assert, strip0x } from '@hyperlane-xyz/utils';

import { RadixPopulate } from './modules/populate.js';
import { RadixQuery } from './modules/query.js';
import { RadixTx } from './modules/tx.js';
import { Account, RadixSDKOptions } from './types.js';
import { generateNewEd25519VirtualAccount } from './utils.js';

// TODO: RADIX
// add mainnet package address after deploying it over https://console.radixdlt.com/deploy-package
const NETWORKS = {
  [NetworkId.Stokenet]: {
    applicationName: 'hyperlane',
    packageAddress:
      'package_tdx_2_1p4r9rl60wz4xc589wp9nusvcllj82e0l7ef825cxmt4rf684wq0j8r',
  },
  [NetworkId.Mainnet]: {
    applicationName: 'hyperlane',
    packageAddress: '',
  },
};

export { NetworkId };

export const DEFAULT_FEE = 100;

export class RadixSDK {
  protected networkId: number;
  protected gateway: GatewayApiClient;

  public applicationName: string;
  public packageAddress: string;

  public query: RadixQuery;
  public populate: RadixPopulate;

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

    this.query = new RadixQuery(this.networkId, this.gateway);
    this.populate = new RadixPopulate(
      this.gateway,
      this.query,
      this.packageAddress,
      options?.gasAmount ?? DEFAULT_FEE,
    );
  }

  public getNetworkId() {
    return this.networkId;
  }
}

export class RadixSigningSDK extends RadixSDK {
  private account: Account;

  public tx: RadixTx;

  constructor(account: Account, options?: RadixSDKOptions) {
    super(options);

    this.account = account;
    this.tx = new RadixTx(
      account,
      this.query,
      this.populate,
      this.networkId,
      this.gateway,
    );
  }

  public getAddress() {
    return this.account.address;
  }

  public static async fromRandomPrivateKey(options?: RadixSDKOptions) {
    const privateKey = Buffer.from(randomBytes(32)).toString('hex');
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
