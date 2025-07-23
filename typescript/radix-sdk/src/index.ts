import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';
import {
  LTSRadixEngineToolkit,
  NetworkId,
} from '@radixdlt/radix-engine-toolkit';
import { BigNumber } from 'bignumber.js';

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
      'package_tdx_2_1p4faa3cx72v0gwguntycgewxnlun34kpkpezf7m7arqyh9crr0v3f3',
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

  public async getXrdAddress() {
    const knownAddresses = await LTSRadixEngineToolkit.Derive.knownAddresses(
      this.networkId,
    );
    return knownAddresses.resources.xrdResource;
  }

  public async getDecimals({
    resource,
  }: {
    resource: string;
  }): Promise<number> {
    const details =
      await this.gateway.state.getEntityDetailsVaultAggregated(resource);

    return (details.details as any).divisibility;
  }

  public async getXrdDecimals(): Promise<number> {
    const xrdAddress = await this.getXrdAddress();
    return this.getDecimals({ resource: xrdAddress });
  }

  public async getBalance({
    address,
    resource,
  }: {
    address: string;
    resource: string;
  }): Promise<bigint> {
    const details =
      await this.gateway.state.getEntityDetailsVaultAggregated(address);

    const fungibleResource = details.fungible_resources.items.find(
      (r) => r.resource_address === resource,
    );

    assert(
      fungibleResource,
      `account with address ${address} has no resource with address ${resource}`,
    );

    if (fungibleResource.vaults.items.length !== 1) {
      return BigInt(0);
    }

    const decimals = await this.getDecimals({ resource });

    return BigInt(
      new BigNumber(fungibleResource.vaults.items[0].amount)
        .times(new BigNumber(10).exponentiatedBy(decimals))
        .toFixed(0),
    );
  }

  public async getXrdBalance({
    address,
  }: {
    address: string;
  }): Promise<bigint> {
    const xrdAddress = await this.getXrdAddress();
    return this.getBalance({ address, resource: xrdAddress });
  }

  public async getTotalSupply({
    resource,
  }: {
    resource: string;
  }): Promise<bigint> {
    const details =
      await this.gateway.state.getEntityDetailsVaultAggregated(resource);

    const decimals = await this.getDecimals({ resource });

    return BigInt(
      new BigNumber((details.details as any).total_supply)
        .times(new BigNumber(10).exponentiatedBy(decimals))
        .toFixed(0),
    );
  }

  public async getXrdTotalSupply(): Promise<bigint> {
    const xrdAddress = await this.getXrdAddress();
    return this.getTotalSupply({ resource: xrdAddress });
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

//   console.log(
//     await sdk.getXrdBalance({
//       address:
//         'component_tdx_2_1czz8fu7dr2n423qeppasaghrepm8ulpslhwchqs5n3ya2sqjf7telm',
//     }),
//   );

//   console.log(await sdk.getXrdTotalSupply());

//   const balance = await sdk.getXrdBalance(sdk.getAddress());
//   console.log('xrd balance', balance);
// await sdk.getTestnetXrd();

// const mailbox = await sdk.createMailbox(75898670);
// console.log('created mailbox with id', mailbox, '\n');

// const merkleTreeHook = await sdk.createMerkleTreeHook(mailbox);
// console.log('created merkleTreeHook with id', merkleTreeHook, '\n');

// const merkleRootMultisigIsm = await sdk.createMerkleRootMultisigIsm(
//   ['0x0c60e7eCd06429052223C78452F791AAb5C5CAc6'],
//   1,
// );
// console.log(
//   'created merkleRootMultisigIsm with id',
//   merkleRootMultisigIsm,
//   '\n',
// );

// const xrd = await sdk.getXrdAddress();
// const igp = await sdk.createIgp(xrd);
// console.log('created igp with id', igp, '\n');

// await sdk.setRequiredHook(mailbox, merkleTreeHook);
// console.log('set required hook\n');

// await sdk.setDefaultHook(mailbox, igp);
// console.log('set default hook\n');

// await sdk.setDefaultIsm(mailbox, merkleRootMultisigIsm);
// console.log('set default ism\n');

// const m = await sdk.queryMailbox(
//   'component_tdx_2_1cqaet9grt80sn9k07hqjtugfg974x2pzmc7k3kcndqqv7895a6v8ux',
// );
// console.log('mailbox state', m, '\n');

// const i = await sdk.queryIsm(merkleRootMultisigIsm);
// console.log('ism state', i, '\n');

//   const h = await sdk.queryIgpHook(
//     'component_tdx_2_1crrt89w8hd5jvvh49jcqgl9wmvmauw0k0wf7yafzahfc276xzu3ak2',
//   );
//   console.log('igp hook state', JSON.stringify(h), '\n');

// const xrd = await sdk.getXrdAddress();
// const collateral = await sdk.createCollateralToken(
//   'component_tdx_2_1cq2vyesapheluv2a796am85cdl7rcgnjkawwkp3axxetv4zcfjzl40',
//   xrd,
// );
// console.log('created collateral token with id', collateral);

// const c = await sdk.queryToken(
//   'component_tdx_2_1cz57khz7zqlppt4jwng5znvzur47yed474h5ck9mdudwdwh2ux8n80',
// );
// console.log('collateral token state', JSON.stringify(c), '\n');

// await sdk.setTokenIsm(
//   'component_tdx_2_1cz57khz7zqlppt4jwng5znvzur47yed474h5ck9mdudwdwh2ux8n80',
//   'component_tdx_2_1czefsgch7kvgvlw2ht5shkna00vjfaexr03xavlcuy73yka6rydr6g',
// );

// const synthetic = await sdk.createSyntheticToken(
//   'component_tdx_2_1cq2vyesapheluv2a796am85cdl7rcgnjkawwkp3axxetv4zcfjzl40',
//   '',
//   '',
//   '',
//   1,
// );
// console.log('created synthetic token with id', synthetic);

//   const s = await sdk.queryToken(
//     'component_tdx_2_1czxew56q0yglq62tvvapyr5gqp8vcswlwzh62999ahrr35gc5jxg32',
//   );
//   console.log('synthetic token state', JSON.stringify(s));

//   await sdk.enrollRemoteRouter(
//     'component_tdx_2_1czxew56q0yglq62tvvapyr5gqp8vcswlwzh62999ahrr35gc5jxg32',
//     1337,
//     '0000000000000000000000000000000000000000000000000000000000000001',
//     '100',
//   );

//   const r = await sdk.queryEnrolledRouters(
//     'component_tdx_2_1czxew56q0yglq62tvvapyr5gqp8vcswlwzh62999ahrr35gc5jxg32',
//     1337,
//   );
//   console.log('query enrolled router', JSON.stringify(r));
// const collateral = await sdk.createCollateralToken(
//   'component_tdx_2_1cq2vyesapheluv2a796am85cdl7rcgnjkawwkp3axxetv4zcfjzl40',
//   'resource_tdx_2_1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxtfd2jc',
// );
// console.log('created collateral token with id', collateral);

//   // collateral
//   const c = await sdk.queryToken(
//     'component_tdx_2_1cqv5pd42nhqyp66ppup3fh7dp9lq5nj0kaa4v2s0pq9sr9w3tky5e6',
//   );
//   console.log('collateral token state', JSON.stringify(c), '\n');

//   // synthetic
//   const s = await sdk.queryToken(
//     'component_tdx_2_1czxew56q0yglq62tvvapyr5gqp8vcswlwzh62999ahrr35gc5jxg32',
//   );
//   console.log('synthetic token state', JSON.stringify(s));

//   console.log(sdk.getAddress());
//   console.log(bech32m.decode(sdk.getAddress()).words);
//   console.log(
//     new Uint8Array(bech32m.fromWords(bech32m.decode(sdk.getAddress()).words)),
//   );

//   const data = new Uint8Array(
//     bech32m.fromWords(bech32m.decode(sdk.getAddress()).words),
//   );

//   console.log(bech32m.encode(`account_tdx_2_`, bech32m.toWords(data)));
// };

// main();
