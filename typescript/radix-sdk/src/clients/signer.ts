import {
  EntityType,
  TransactionManifest,
} from '@radixdlt/radix-engine-toolkit';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { assert, strip0x } from '@hyperlane-xyz/utils';

import { RadixBaseSigner } from '../utils/signer.js';
import {
  Account,
  RadixSDKOptions,
  RadixSDKReceipt,
  RadixSDKTransaction,
} from '../utils/types.js';
import {
  generateNewEd25519VirtualAccount,
  stringToTransactionManifest,
  transactionManifestToString,
} from '../utils/utils.js';

import { RadixProvider } from './provider.js';

type RadixSignerMetadata = {
  chainId?: string | number;
  gatewayUrls?: { http: string }[];
  packageAddress?: string;
};

type RadixSignerConnectionParams = {
  metadata?: RadixSignerMetadata;
};

export class RadixSigner
  extends RadixProvider
  implements AltVM.ISigner<RadixSDKTransaction, RadixSDKReceipt>
{
  private account: Account;

  private signer: RadixBaseSigner;

  private constructor(account: Account, options: RadixSDKOptions) {
    super(options);

    this.account = account;
    this.signer = new RadixBaseSigner(
      this.networkId,
      this.gateway,
      this.base,
      this.account,
    );
  }

  static async connectWithSigner(
    rpcUrls: string[],
    privateKey: string,
    extraParams?: RadixSignerConnectionParams,
  ): Promise<RadixSigner> {
    assert(extraParams, `extra params not defined`);

    const metadata = extraParams.metadata;
    assert(metadata, `metadata not defined in extra params`);
    assert(metadata.chainId, `chainId not defined in metadata extra params`);

    const networkId = parseInt(metadata.chainId.toString());

    const account = await generateNewEd25519VirtualAccount(
      strip0x(privateKey),
      networkId,
    );

    return new RadixSigner(account, {
      networkId,
      rpcUrls,
      gatewayUrls: metadata.gatewayUrls?.map(({ http }) => http),
      packageAddress: metadata.packageAddress,
    });
  }

  getSignerAddress(): string {
    return this.account.address;
  }

  supportsTransactionBatching(): boolean {
    return false;
  }

  getBaseSigner(): RadixBaseSigner {
    return this.signer;
  }

  getGatewayClient() {
    return this.gateway;
  }

  getBaseClient() {
    return this.base;
  }

  async transactionToPrintableJson(
    transaction: RadixSDKTransaction,
  ): Promise<object> {
    let manifest: string;

    if (typeof transaction.manifest === 'string') {
      manifest = transaction.manifest;
    } else {
      manifest = await transactionManifestToString(
        transaction.manifest,
        this.networkId,
      );
    }

    return {
      ...transaction,
      manifest,
    };
  }

  async sendAndConfirmTransaction(
    transaction: RadixSDKTransaction,
  ): Promise<RadixSDKReceipt> {
    assert(
      transaction.networkId === this.networkId,
      `Transaction networkId (${transaction.networkId}) does not match signer networkId (${this.networkId})`,
    );

    let manifest: TransactionManifest;

    if (typeof transaction.manifest === 'string') {
      manifest = await stringToTransactionManifest(
        transaction.manifest,
        transaction.networkId,
      );
    } else {
      manifest = transaction.manifest;
    }

    return this.signer.signAndBroadcast(manifest);
  }

  async sendAndConfirmBatchTransactions(
    _transactions: RadixSDKTransaction[],
  ): Promise<RadixSDKReceipt> {
    throw new Error(`Radix does not support transaction batching`);
  }

  async publishPackage(params: {
    code: Uint8Array;
    packageDefinition: Uint8Array;
  }): Promise<string> {
    const { code, packageDefinition } = params;

    const transactionManifest = await this.base.createPublishPackageManifest({
      from_address: this.account.address,
      code,
      packageDefinition,
    });

    const receipt = await this.signer.signAndBroadcast(transactionManifest);

    // Extract package address from transaction receipt
    const transactionStateUpdates = receipt.transaction.receipt
      ?.state_updates as
      | {
          new_global_entities?: {
            entity_type: EntityType;
            entity_address: string;
          }[];
        }
      | undefined;

    assert(
      transactionStateUpdates?.new_global_entities,
      `Expected global entities to be created when publishing a package on Radix network with id "${this.networkId}"`,
    );

    const publishedPackageInfo =
      transactionStateUpdates.new_global_entities.find(
        (entity) => entity.entity_type === EntityType.GlobalPackage,
      );
    assert(
      publishedPackageInfo,
      `Expected global package info to be defined after publishing a new package on Radix network with id "${this.networkId}"`,
    );

    return publishedPackageInfo.entity_address;
  }
}
