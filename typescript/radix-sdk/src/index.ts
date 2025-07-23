import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';
import { NetworkId } from '@radixdlt/radix-engine-toolkit';

import { assert } from '@hyperlane-xyz/utils';

import { RadixPopulate } from './modules/populate.js';
import { RadixQuery } from './modules/query.js';
import { RadixTx } from './modules/tx.js';
import { Account, RadixSDKOptions } from './types.js';
import {
  generateNewEd25519VirtualAccount,
  generateSecureRandomBytes,
} from './utils.js';

const NETWORKS = {
  [NetworkId.Stokenet]: {
    applicationName: 'hyperlane',
    packageAddress:
      'package_tdx_2_1pkwm6pc3yvjuh482nkp7p276t7f3kuw92vqzfy6a4urfvp3ep9tdpk',
  },
  [NetworkId.Mainnet]: {
    applicationName: 'hyperlane',
    packageAddress: '',
  },
};

export { NetworkId };

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
      options?.gasAmount ?? 5000,
    );
  }
}

export class RadixSigningSDK extends RadixSDK {
  private account: Account;

  public tx: RadixTx;

  constructor(account: Account, options?: RadixSDKOptions) {
    super(options);

    this.account = account;
    this.tx = new RadixTx(account, this.populate, this.networkId, this.gateway);
  }

  public getAddress() {
    return this.account.address;
  }

  public static async fromRandomPrivateKey(options?: RadixSDKOptions) {
    const privateKey = Buffer.from(
      await generateSecureRandomBytes(32),
    ).toString('hex');
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
      privateKey,
      options?.networkId ?? NetworkId.Mainnet,
    );
    return new RadixSigningSDK(account, options);
  }
}

// TODO: RADIX
// const main = async () => {
//   const sdk = await RadixSigningSDK.fromPrivateKey(
//     '4f61d7cd8c2bebd01ff86da87001cbe0a2349fa5ba43ef95eee5d0d817b035cc',
//     {
//       networkId: NetworkId.Stokenet,
//     },
//   );

//   const address = sdk.getAddress();

//   console.log(
//     await sdk.query.getXrdBalance({
//       address,
//     }),
//   );

//   console.log(await sdk.query.getXrdTotalSupply());

//   const mailbox = await sdk.tx.createMailbox({ domain_id: 75898670 });
//   console.log('created mailbox with id', mailbox, '\n');

//   const merkleTreeHook = await sdk.tx.createMerkleTreeHook({ mailbox });
//   console.log('created merkleTreeHook with id', merkleTreeHook, '\n');

//   const merkleRootMultisigIsm = await sdk.tx.createMerkleRootMultisigIsm({
//     validators: ['0x0c60e7eCd06429052223C78452F791AAb5C5CAc6'],
//     threshold: 1,
//   });
//   console.log(
//     'created merkleRootMultisigIsm with id',
//     merkleRootMultisigIsm,
//     '\n',
//   );

//   const xrd = await sdk.query.getXrdAddress();
//   const igp = await sdk.tx.createIgp({ denom: xrd });
//   console.log('created igp with id', igp, '\n');

//   await sdk.tx.setRequiredHook({ mailbox, hook: merkleTreeHook });
//   console.log('set required hook\n');

//   await sdk.tx.setDefaultHook({ mailbox, hook: igp });
//   console.log('set default hook\n');

//   await sdk.tx.setDefaultIsm({ mailbox, ism: merkleRootMultisigIsm });
//   console.log('set default ism\n');

//   const m = await sdk.query.getMailbox({
//     mailbox:
//       'component_tdx_2_1cqaet9grt80sn9k07hqjtugfg974x2pzmc7k3kcndqqv7895a6v8ux',
//   });
//   console.log('mailbox state', m, '\n');

//   const i = await sdk.query.getIsm({ ism: merkleRootMultisigIsm });
//   console.log('ism state', i, '\n');

//   const h = await sdk.query.getIgpHook({
//     hook: 'component_tdx_2_1crrt89w8hd5jvvh49jcqgl9wmvmauw0k0wf7yafzahfc276xzu3ak2',
//   });
//   console.log('igp hook state', JSON.stringify(h), '\n');

//   const collateral = await sdk.tx.createCollateralToken({
//     mailbox:
//       'component_tdx_2_1cq2vyesapheluv2a796am85cdl7rcgnjkawwkp3axxetv4zcfjzl40',
//     origin_denom: xrd,
//   });
//   console.log('created collateral token with id', collateral);

//   const c = await sdk.query.getToken({ token: collateral });
//   console.log('collateral token state', JSON.stringify(c), '\n');

//   await sdk.tx.setTokenIsm({
//     token: collateral,
//     ism: merkleRootMultisigIsm,
//   });

//   const synthetic = await sdk.tx.createSyntheticToken({
//     mailbox,
//     name: 'TEST',
//     symbol: 'TEST',
//     description: 'TEST token for hyperlane',
//     divisibility: 6,
//   });
//   console.log('created synthetic token with id', synthetic);

//   const s = await sdk.query.getToken({ token: synthetic });
//   console.log('synthetic token state', JSON.stringify(s));

//   await sdk.tx.enrollRemoteRouter({
//     token: synthetic,
//     receiver_domain: 1337,
//     receiver_address:
//       '0000000000000000000000000000000000000000000000000000000000000001',
//     gas: '100',
//   });

//   const r = await sdk.query.getRemoteRouters({
//     token: synthetic,
//   });
//   console.log('query remote routers', JSON.stringify(r));
// };

// main();

// COLLATERAL: component_tdx_2_1cqz8a07x8hmc2qyqg3glyut9te4lpcc2qelgn740lceasgwwv3dgjs
// SYNTHETIC: component_tdx_2_1cq7jh99kkg9exmucxm3j5w4wru3qfpfxy3s3etar20c63dj37mh2cj
