import {
  EntityType,
  TransactionManifest,
} from '@radixdlt/radix-engine-toolkit';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { assert, strip0x } from '@hyperlane-xyz/utils';

import {
  getCreateIgpTx,
  getCreateMerkleTreeHookTx,
  getSetIgpDestinationGasConfigTx,
  getSetIgpOwnerTx,
} from '../hook/hook-tx.js';
import {
  getCreateMerkleRootMultisigIsmTx,
  getCreateMessageIdMultisigIsmTx,
  getCreateNoopIsmTx,
  getCreateRoutingIsmTx,
  getRemoveRoutingIsmDomainIsmTx,
  getSetRoutingIsmDomainIsmTx,
  getSetRoutingIsmOwnerTx,
} from '../ism/ism-tx.js';
import {
  getCreateMailboxTx,
  getSetMailboxDefaultHookTx,
  getSetMailboxDefaultIsmTx,
  getSetMailboxOwnerTx,
  getSetMailboxRequiredHookTx,
} from '../mailbox/mailbox-tx.js';
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
import { getCreateValidatorAnnounceTx } from '../validator-announce/validator-announce-tx.js';
import { RadixWarpTx } from '../warp/tx.js';

import { RadixProvider } from './provider.js';

export class RadixSigner
  extends RadixProvider
  implements AltVM.ISigner<RadixSDKTransaction, RadixSDKReceipt>
{
  private account: Account;

  private tx: {
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
    const transactionManifest = await getCreateMailboxTx(
      this.base,
      this.account.address,
      req.domainId,
    );

    const receipt = await this.signer.signAndBroadcast(transactionManifest);

    const mailboxAddress = await this.base.getNewComponent(receipt);
    return {
      mailboxAddress,
    };
  }

  async setDefaultIsm(
    req: Omit<AltVM.ReqSetDefaultIsm, 'signer'>,
  ): Promise<AltVM.ResSetDefaultIsm> {
    const transactionManifest = await getSetMailboxDefaultIsmTx(
      this.base,
      this.account.address,
      {
        mailboxAddress: req.mailboxAddress,
        ismAddress: req.ismAddress,
      },
    );

    await this.signer.signAndBroadcast(transactionManifest);
    return {
      ismAddress: req.ismAddress,
    };
  }

  async setDefaultHook(
    req: Omit<AltVM.ReqSetDefaultHook, 'signer'>,
  ): Promise<AltVM.ResSetDefaultHook> {
    const transactionManifest = await getSetMailboxDefaultHookTx(
      this.base,
      this.account.address,
      {
        mailboxAddress: req.mailboxAddress,
        hookAddress: req.hookAddress,
      },
    );

    await this.signer.signAndBroadcast(transactionManifest);
    return {
      hookAddress: req.hookAddress,
    };
  }

  async setRequiredHook(
    req: Omit<AltVM.ReqSetRequiredHook, 'signer'>,
  ): Promise<AltVM.ResSetRequiredHook> {
    const transactionManifest = await getSetMailboxRequiredHookTx(
      this.base,
      this.account.address,
      {
        mailboxAddress: req.mailboxAddress,
        hookAddress: req.hookAddress,
      },
    );

    await this.signer.signAndBroadcast(transactionManifest);
    return {
      hookAddress: req.hookAddress,
    };
  }

  async setMailboxOwner(
    req: Omit<AltVM.ReqSetMailboxOwner, 'signer'>,
  ): Promise<AltVM.ResSetMailboxOwner> {
    const transactionManifest = await getSetMailboxOwnerTx(
      this.base,
      this.gateway,
      this.account.address,
      {
        mailboxAddress: req.mailboxAddress,
        newOwner: req.newOwner,
      },
    );

    await this.signer.signAndBroadcast(transactionManifest);

    return {
      newOwner: req.newOwner,
    };
  }

  async createMerkleRootMultisigIsm(
    req: Omit<AltVM.ReqCreateMerkleRootMultisigIsm, 'signer'>,
  ): Promise<AltVM.ResCreateMerkleRootMultisigIsm> {
    const transactionManifest = await getCreateMerkleRootMultisigIsmTx(
      this.base,
      this.account.address,
      {
        validators: req.validators,
        threshold: req.threshold,
      },
    );

    const receipt = await this.signer.signAndBroadcast(transactionManifest);

    const ismAddress = await this.base.getNewComponent(receipt);
    return {
      ismAddress,
    };
  }

  async createMessageIdMultisigIsm(
    req: Omit<AltVM.ReqCreateMessageIdMultisigIsm, 'signer'>,
  ): Promise<AltVM.ResCreateMessageIdMultisigIsm> {
    const transactionManifest = await getCreateMessageIdMultisigIsmTx(
      this.base,
      this.account.address,
      {
        validators: req.validators,
        threshold: req.threshold,
      },
    );

    const receipt = await this.signer.signAndBroadcast(transactionManifest);

    const ismAddress = await this.base.getNewComponent(receipt);
    return {
      ismAddress,
    };
  }

  async createRoutingIsm(
    req: Omit<AltVM.ReqCreateRoutingIsm, 'signer'>,
  ): Promise<AltVM.ResCreateRoutingIsm> {
    const transactionManifest = await getCreateRoutingIsmTx(
      this.base,
      this.account.address,
      req.routes,
    );

    const receipt = await this.signer.signAndBroadcast(transactionManifest);

    const ismAddress = await this.base.getNewComponent(receipt);
    return {
      ismAddress,
    };
  }

  async setRoutingIsmRoute(
    req: Omit<AltVM.ReqSetRoutingIsmRoute, 'signer'>,
  ): Promise<AltVM.ResSetRoutingIsmRoute> {
    const transactionManifest = await getSetRoutingIsmDomainIsmTx(
      this.base,
      this.account.address,
      {
        ismAddress: req.ismAddress,
        domainIsm: req.route,
      },
    );

    await this.signer.signAndBroadcast(transactionManifest);

    return {
      route: req.route,
    };
  }

  async removeRoutingIsmRoute(
    req: Omit<AltVM.ReqRemoveRoutingIsmRoute, 'signer'>,
  ): Promise<AltVM.ResRemoveRoutingIsmRoute> {
    const transactionManifest = await getRemoveRoutingIsmDomainIsmTx(
      this.base,
      this.account.address,
      {
        ismAddress: req.ismAddress,
        domainId: req.domainId,
      },
    );

    await this.signer.signAndBroadcast(transactionManifest);

    return {
      domainId: req.domainId,
    };
  }

  async setRoutingIsmOwner(
    req: Omit<AltVM.ReqSetRoutingIsmOwner, 'signer'>,
  ): Promise<AltVM.ResSetRoutingIsmOwner> {
    const transactionManifest = await getSetRoutingIsmOwnerTx(
      this.base,
      this.gateway,
      this.account.address,
      {
        ismAddress: req.ismAddress,
        newOwner: req.newOwner,
      },
    );

    await this.signer.signAndBroadcast(transactionManifest);
    return {
      newOwner: req.newOwner,
    };
  }

  async createNoopIsm(
    _req: Omit<AltVM.ReqCreateNoopIsm, 'signer'>,
  ): Promise<AltVM.ResCreateNoopIsm> {
    const transactionManifest = await getCreateNoopIsmTx(
      this.base,
      this.account.address,
    );

    const receipt = await this.signer.signAndBroadcast(transactionManifest);

    const ismAddress = await this.base.getNewComponent(receipt);
    return {
      ismAddress,
    };
  }

  async createMerkleTreeHook(
    req: Omit<AltVM.ReqCreateMerkleTreeHook, 'signer'>,
  ): Promise<AltVM.ResCreateMerkleTreeHook> {
    const transactionManifest = await getCreateMerkleTreeHookTx(
      this.base,
      this.account.address,
      req.mailboxAddress,
    );

    const receipt = await this.signer.signAndBroadcast(transactionManifest);

    const hookAddress = await this.base.getNewComponent(receipt);
    return {
      hookAddress,
    };
  }

  async createInterchainGasPaymasterHook(
    req: Omit<AltVM.ReqCreateInterchainGasPaymasterHook, 'signer'>,
  ): Promise<AltVM.ResCreateInterchainGasPaymasterHook> {
    assert(req.denom, `denom required by ${RadixProvider.name}`);

    const transactionManifest = await getCreateIgpTx(
      this.base,
      this.account.address,
      req.denom,
    );

    const receipt = await this.signer.signAndBroadcast(transactionManifest);

    const hookAddress = await this.base.getNewComponent(receipt);
    return {
      hookAddress,
    };
  }

  async setInterchainGasPaymasterHookOwner(
    req: Omit<AltVM.ReqSetInterchainGasPaymasterHookOwner, 'signer'>,
  ): Promise<AltVM.ResSetInterchainGasPaymasterHookOwner> {
    const transactionManifest = await getSetIgpOwnerTx(
      this.base,
      this.gateway,
      this.account.address,
      {
        igpAddress: req.hookAddress,
        newOwner: req.newOwner,
      },
    );

    await this.signer.signAndBroadcast(transactionManifest);
    return {
      newOwner: req.newOwner,
    };
  }

  async setDestinationGasConfig(
    req: Omit<AltVM.ReqSetDestinationGasConfig, 'signer'>,
  ): Promise<AltVM.ResSetDestinationGasConfig> {
    const transactionManifest = await getSetIgpDestinationGasConfigTx(
      this.base,
      this.account.address,
      {
        igpAddress: req.hookAddress,
        destinationGasConfig: req.destinationGasConfig,
      },
    );

    await this.signer.signAndBroadcast(transactionManifest);
    return {
      destinationGasConfig: req.destinationGasConfig,
    };
  }

  async removeDestinationGasConfig(
    _req: Omit<AltVM.ReqRemoveDestinationGasConfig, 'signer'>,
  ): Promise<AltVM.ResRemoveDestinationGasConfig> {
    throw new Error(
      `RemoveDestinationGasConfig is currently not supported on Radix`,
    );
  }

  async createNoopHook(
    _req: Omit<AltVM.ReqCreateNoopHook, 'signer'>,
  ): Promise<AltVM.ResCreateNoopHook> {
    throw new Error(`CreateNoopHook is currently not supported on Radix`);
  }

  async createValidatorAnnounce(
    req: Omit<AltVM.ReqCreateValidatorAnnounce, 'signer'>,
  ): Promise<AltVM.ResCreateValidatorAnnounce> {
    const transactionManifest = await getCreateValidatorAnnounceTx(
      this.base,
      this.account.address,
      req.mailboxAddress,
    );

    const receipt = await this.signer.signAndBroadcast(transactionManifest);

    const validatorAnnounceId = await this.base.getNewComponent(receipt);
    return {
      validatorAnnounceId,
    };
  }

  // ### TX WARP ###

  async createNativeToken(
    _req: Omit<AltVM.ReqCreateNativeToken, 'signer'>,
  ): Promise<AltVM.ResCreateNativeToken> {
    throw new Error(`Native Token is not supported on Radix`);
  }

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

  async setTokenHook(
    _req: Omit<AltVM.ReqSetTokenHook, 'signer'>,
  ): Promise<AltVM.ResSetTokenHook> {
    throw new Error(`SetTokenHook is currently not supported on Radix`);
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
    assert(req.denom, `denom required by ${RadixProvider.name}`);

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
