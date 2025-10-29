import {
  EntityType,
  TransactionManifest,
} from '@radixdlt/radix-engine-toolkit';

import { AltVM, assert, strip0x } from '@hyperlane-xyz/utils';

import { RadixCoreTx } from '../core/tx.js';
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
import { RadixWarpTx } from '../warp/tx.js';

import { RadixProvider } from './provider.js';

export class RadixSigner
  extends RadixProvider
  implements AltVM.ISigner<RadixSDKTransaction, RadixSDKReceipt>
{
  private account: Account;

  private tx: {
    core: RadixCoreTx;
    warp: RadixWarpTx;
  };
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
    this.tx = {
      core: new RadixCoreTx(
        account,
        this.base,
        this.signer,
        this.populate.core,
      ),
      warp: new RadixWarpTx(
        account,
        this.networkId,
        this.base,
        this.signer,
        this.populate.warp,
      ),
    };
  }

  static async connectWithSigner(
    rpcUrls: string[],
    privateKey: string,
    extraParams?: Record<string, any>,
  ): Promise<AltVM.ISigner<RadixSDKTransaction, RadixSDKReceipt>> {
    assert(extraParams, `extra params not defined`);

    const metadata = extraParams.metadata as Record<string, unknown>;
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
      gatewayUrls: (metadata?.gatewayUrls as { http: string }[])?.map(
        ({ http }) => http,
      ),
      packageAddress: metadata.packageAddress as string | undefined,
    });
  }

  getSignerAddress(): string {
    return this.account.address;
  }

  supportsTransactionBatching(): boolean {
    return false;
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

  // ### TX CORE ###

  async createMailbox(
    req: Omit<AltVM.ReqCreateMailbox, 'signer'>,
  ): Promise<AltVM.ResCreateMailbox> {
    return {
      mailboxAddress: await this.tx.core.createMailbox({
        domain_id: req.domainId,
      }),
    };
  }

  async setDefaultIsm(
    req: Omit<AltVM.ReqSetDefaultIsm, 'signer'>,
  ): Promise<AltVM.ResSetDefaultIsm> {
    await this.tx.core.setDefaultIsm({
      mailbox: req.mailboxAddress,
      ism: req.ismAddress,
    });

    return {
      ismAddress: req.ismAddress,
    };
  }

  async setDefaultHook(
    req: Omit<AltVM.ReqSetDefaultHook, 'signer'>,
  ): Promise<AltVM.ResSetDefaultHook> {
    await this.tx.core.setDefaultHook({
      mailbox: req.mailboxAddress,
      hook: req.hookAddress,
    });

    return {
      hookAddress: req.hookAddress,
    };
  }

  async setRequiredHook(
    req: Omit<AltVM.ReqSetRequiredHook, 'signer'>,
  ): Promise<AltVM.ResSetRequiredHook> {
    await this.tx.core.setRequiredHook({
      mailbox: req.mailboxAddress,
      hook: req.hookAddress,
    });

    return {
      hookAddress: req.hookAddress,
    };
  }

  async setMailboxOwner(
    req: Omit<AltVM.ReqSetMailboxOwner, 'signer'>,
  ): Promise<AltVM.ResSetMailboxOwner> {
    await this.tx.core.setMailboxOwner({
      mailbox: req.mailboxAddress,
      new_owner: req.newOwner,
    });

    return {
      newOwner: req.newOwner,
    };
  }

  async createMerkleRootMultisigIsm(
    req: Omit<AltVM.ReqCreateMerkleRootMultisigIsm, 'signer'>,
  ): Promise<AltVM.ResCreateMerkleRootMultisigIsm> {
    return {
      ismAddress: await this.tx.core.createMerkleRootMultisigIsm({
        validators: req.validators,
        threshold: req.threshold,
      }),
    };
  }

  async createMessageIdMultisigIsm(
    req: Omit<AltVM.ReqCreateMessageIdMultisigIsm, 'signer'>,
  ): Promise<AltVM.ResCreateMessageIdMultisigIsm> {
    return {
      ismAddress: await this.tx.core.createMessageIdMultisigIsm({
        validators: req.validators,
        threshold: req.threshold,
      }),
    };
  }

  async createRoutingIsm(
    req: Omit<AltVM.ReqCreateRoutingIsm, 'signer'>,
  ): Promise<AltVM.ResCreateRoutingIsm> {
    return {
      ismAddress: await this.tx.core.createRoutingIsm({
        routes: req.routes,
      }),
    };
  }

  async setRoutingIsmRoute(
    req: Omit<AltVM.ReqSetRoutingIsmRoute, 'signer'>,
  ): Promise<AltVM.ResSetRoutingIsmRoute> {
    await this.tx.core.setRoutingIsmRoute({
      ism: req.ismAddress,
      route: req.route,
    });

    return {
      route: req.route,
    };
  }

  async removeRoutingIsmRoute(
    req: Omit<AltVM.ReqRemoveRoutingIsmRoute, 'signer'>,
  ): Promise<AltVM.ResRemoveRoutingIsmRoute> {
    await this.tx.core.removeRoutingIsmRoute({
      ism: req.ismAddress,
      domain: req.domainId,
    });

    return {
      domainId: req.domainId,
    };
  }

  async setRoutingIsmOwner(
    req: Omit<AltVM.ReqSetRoutingIsmOwner, 'signer'>,
  ): Promise<AltVM.ResSetRoutingIsmOwner> {
    await this.tx.core.setRoutingIsmOwner({
      ism: req.ismAddress,
      new_owner: req.newOwner,
    });

    return {
      newOwner: req.newOwner,
    };
  }

  async createNoopIsm(
    _req: Omit<AltVM.ReqCreateNoopIsm, 'signer'>,
  ): Promise<AltVM.ResCreateNoopIsm> {
    return {
      ismAddress: await this.tx.core.createNoopIsm(),
    };
  }

  async createMerkleTreeHook(
    req: Omit<AltVM.ReqCreateMerkleTreeHook, 'signer'>,
  ): Promise<AltVM.ResCreateMerkleTreeHook> {
    return {
      hookAddress: await this.tx.core.createMerkleTreeHook({
        mailbox: req.mailboxAddress,
      }),
    };
  }

  async createInterchainGasPaymasterHook(
    req: Omit<AltVM.ReqCreateInterchainGasPaymasterHook, 'signer'>,
  ): Promise<AltVM.ResCreateInterchainGasPaymasterHook> {
    return {
      hookAddress: await this.tx.core.createIgp({
        denom: req.denom,
      }),
    };
  }

  async setInterchainGasPaymasterHookOwner(
    req: Omit<AltVM.ReqSetInterchainGasPaymasterHookOwner, 'signer'>,
  ): Promise<AltVM.ResSetInterchainGasPaymasterHookOwner> {
    await this.tx.core.setIgpOwner({
      igp: req.hookAddress,
      new_owner: req.newOwner,
    });

    return {
      newOwner: req.newOwner,
    };
  }

  async setDestinationGasConfig(
    req: Omit<AltVM.ReqSetDestinationGasConfig, 'signer'>,
  ): Promise<AltVM.ResSetDestinationGasConfig> {
    await this.tx.core.setDestinationGasConfig({
      igp: req.hookAddress,
      destinationGasConfig: req.destinationGasConfig,
    });

    return {
      destinationGasConfig: req.destinationGasConfig,
    };
  }

  async createValidatorAnnounce(
    req: Omit<AltVM.ReqCreateValidatorAnnounce, 'signer'>,
  ): Promise<AltVM.ResCreateValidatorAnnounce> {
    return {
      validatorAnnounceId: await this.tx.core.createValidatorAnnounce({
        mailbox: req.mailboxAddress,
      }),
    };
  }

  // ### TX WARP ###

  async createCollateralToken(
    req: Omit<AltVM.ReqCreateCollateralToken, 'signer'>,
  ): Promise<AltVM.ResCreateCollateralToken> {
    return {
      tokenAddress: await this.tx.warp.createCollateralToken({
        mailbox: req.mailboxAddress,
        origin_denom: req.collateralDenom,
      }),
    };
  }

  async createSyntheticToken(
    req: Omit<AltVM.ReqCreateSyntheticToken, 'signer'>,
  ): Promise<AltVM.ResCreateSyntheticToken> {
    return {
      tokenAddress: await this.tx.warp.createSyntheticToken({
        mailbox: req.mailboxAddress,
        name: req.name,
        symbol: req.denom,
        divisibility: req.decimals,
      }),
    };
  }

  async setTokenOwner(
    req: Omit<AltVM.ReqSetTokenOwner, 'signer'>,
  ): Promise<AltVM.ResSetTokenOwner> {
    await this.tx.warp.setTokenOwner({
      token: req.tokenAddress,
      new_owner: req.newOwner,
    });

    return {
      newOwner: req.newOwner,
    };
  }

  async setTokenIsm(
    req: Omit<AltVM.ReqSetTokenIsm, 'signer'>,
  ): Promise<AltVM.ResSetTokenIsm> {
    await this.tx.warp.setTokenIsm({
      token: req.tokenAddress,
      ism: req.ismAddress,
    });

    return {
      ismAddress: req.ismAddress,
    };
  }

  async enrollRemoteRouter(
    req: Omit<AltVM.ReqEnrollRemoteRouter, 'signer'>,
  ): Promise<AltVM.ResEnrollRemoteRouter> {
    await this.tx.warp.enrollRemoteRouter({
      token: req.tokenAddress,
      receiver_domain: req.remoteRouter.receiverDomainId,
      receiver_address: req.remoteRouter.receiverAddress,
      gas: req.remoteRouter.gas,
    });

    return {
      receiverDomainId: req.remoteRouter.receiverDomainId,
    };
  }

  async unenrollRemoteRouter(
    req: Omit<AltVM.ReqUnenrollRemoteRouter, 'signer'>,
  ): Promise<AltVM.ResUnenrollRemoteRouter> {
    await this.tx.warp.unenrollRemoteRouter({
      token: req.tokenAddress,
      receiver_domain: req.receiverDomainId,
    });

    return {
      receiverDomainId: req.receiverDomainId,
    };
  }

  async transfer(
    req: Omit<AltVM.ReqTransfer, 'signer'>,
  ): Promise<AltVM.ResTransfer> {
    const manifest = await this.base.transfer({
      from_address: this.account.address,
      to_address: req.recipient,
      amount: req.amount,
      resource_address: req.denom,
    });

    await this.signer.signAndBroadcast(manifest);

    return {
      recipient: req.recipient,
    };
  }

  async remoteTransfer(
    req: Omit<AltVM.ReqRemoteTransfer, 'signer'>,
  ): Promise<AltVM.ResRemoteTransfer> {
    await this.tx.warp.remoteTransfer({
      token: req.tokenAddress,
      destination_domain: req.destinationDomainId,
      recipient: req.recipient,
      amount: req.amount,
      custom_hook_id: req.customHookAddress || '',
      gas_limit: req.gasLimit,
      custom_hook_metadata: req.customHookMetadata || '',
      max_fee: req.maxFee,
    });

    return { tokenAddress: req.tokenAddress };
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
