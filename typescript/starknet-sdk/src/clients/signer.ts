import {
  Account,
  CallData,
  ContractFactory,
  GetTransactionReceiptResponse,
} from 'starknet';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk/chain';
import { TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import {
  ContractType,
  getCompiledContract,
} from '@hyperlane-xyz/starknet-core';
import { ZERO_ADDRESS_HEX_32, assert } from '@hyperlane-xyz/utils';

import { normalizeStarknetAddressSafe } from '../contracts.js';
import {
  StarknetAnnotatedTx,
  StarknetDeployTx,
  StarknetInvokeTx,
  StarknetTxReceipt,
} from '../types.js';

import { StarknetProvider } from './provider.js';

export class StarknetSigner
  extends StarknetProvider
  implements AltVM.ISigner<StarknetAnnotatedTx, StarknetTxReceipt>
{
  static async connectWithSigner(
    rpcUrls: string[],
    privateKey: string,
    extraParams?: Record<string, any>,
  ): Promise<AltVM.ISigner<StarknetAnnotatedTx, TxReceipt>> {
    assert(extraParams?.metadata, 'metadata missing for Starknet signer');
    const metadata = extraParams.metadata as ChainMetadataForAltVM;
    const accountAddress = extraParams.accountAddress as string | undefined;
    assert(accountAddress, 'accountAddress missing for Starknet signer');
    assert(privateKey, 'private key missing for Starknet signer');

    const provider = StarknetProvider.connect(rpcUrls, metadata.chainId, {
      metadata,
    });

    return new StarknetSigner(
      (provider as any).provider,
      metadata,
      rpcUrls,
      normalizeStarknetAddressSafe(accountAddress),
      privateKey,
    );
  }

  private readonly account: Account;

  protected constructor(
    provider: any,
    metadata: ChainMetadataForAltVM,
    rpcUrls: string[],
    private readonly signerAddress: string,
    privateKey: string,
  ) {
    super(provider, metadata, rpcUrls);
    this.account = new Account(provider, signerAddress, privateKey);
  }

  protected override get accountAddress(): string {
    return this.signerAddress;
  }

  getSignerAddress(): string {
    return this.signerAddress;
  }

  supportsTransactionBatching(): boolean {
    return false;
  }

  async transactionToPrintableJson(
    transaction: StarknetAnnotatedTx,
  ): Promise<object> {
    return transaction;
  }

  private async deployContract(params: {
    contractName: string;
    constructorArgs: any[];
    contractType?: ContractType;
  }): Promise<{
    transactionHash: string;
    contractAddress: string;
    receipt: GetTransactionReceiptResponse;
  }> {
    const compiledContract = getCompiledContract(
      params.contractName,
      params.contractType,
    );
    const constructorCalldata = CallData.compile(params.constructorArgs);

    const factory = new ContractFactory({
      compiledContract,
      account: this.account,
    } as any);

    const deployment = await factory.deploy(constructorCalldata);

    const transactionHash =
      (deployment as any).deployTransactionHash ||
      (deployment as any).transaction_hash;
    assert(transactionHash, 'missing Starknet deploy transaction hash');

    const address = normalizeStarknetAddressSafe(
      (deployment as any).address || (deployment as any).contract_address,
    );
    const receipt = await this.account.waitForTransaction(transactionHash);

    return {
      transactionHash,
      contractAddress: address,
      receipt,
    };
  }

  async sendAndConfirmTransaction(
    transaction: StarknetAnnotatedTx,
  ): Promise<StarknetTxReceipt> {
    if ((transaction as StarknetDeployTx).kind === 'deploy') {
      const deployTx = transaction as StarknetDeployTx;
      const deployed = await this.deployContract({
        contractName: deployTx.contractName,
        constructorArgs: deployTx.constructorArgs,
        contractType: deployTx.contractType,
      });

      return {
        transactionHash: deployed.transactionHash,
        contractAddress: deployed.contractAddress,
        receipt: deployed.receipt,
      };
    }

    const invokeTx = transaction as StarknetInvokeTx;
    const calls = invokeTx.calls ?? [
      {
        contractAddress: invokeTx.contractAddress,
        entrypoint: invokeTx.entrypoint,
        calldata: invokeTx.calldata,
      },
    ];

    const response = await this.account.execute(calls as any);
    const transactionHash = (response as any).transaction_hash as string;
    const receipt = await this.account.waitForTransaction(transactionHash);

    return { transactionHash, receipt };
  }

  async sendAndConfirmBatchTransactions(
    transactions: StarknetAnnotatedTx[],
  ): Promise<StarknetTxReceipt> {
    const hasDeploy = transactions.some((tx) => tx.kind === 'deploy');
    if (hasDeploy) {
      throw new Error(
        'Batch transactions with deploy operations are unsupported on Starknet signer',
      );
    }

    const calls = transactions.flatMap((tx) => {
      const invoke = tx as StarknetInvokeTx;
      return (
        invoke.calls || [
          {
            contractAddress: invoke.contractAddress,
            entrypoint: invoke.entrypoint,
            calldata: invoke.calldata,
          },
        ]
      );
    });

    const response = await this.account.execute(calls as any);
    const transactionHash = (response as any).transaction_hash as string;
    const receipt = await this.account.waitForTransaction(transactionHash);
    return { transactionHash, receipt };
  }

  // ### TX CORE ###

  async createMailbox(
    req: Omit<AltVM.ReqCreateMailbox, 'signer'>,
  ): Promise<AltVM.ResCreateMailbox> {
    if (req.proxyAdminAddress) {
      throw new Error('Proxy admin unsupported on Starknet');
    }

    const tx = await this.getCreateMailboxTransaction({
      signer: this.signerAddress,
      ...req,
    });
    const receipt = await this.sendAndConfirmTransaction(tx);
    assert(receipt.contractAddress, 'failed to get Starknet mailbox address');
    return { mailboxAddress: receipt.contractAddress };
  }

  async setDefaultIsm(
    req: Omit<AltVM.ReqSetDefaultIsm, 'signer'>,
  ): Promise<AltVM.ResSetDefaultIsm> {
    const tx = await this.getSetDefaultIsmTransaction({
      signer: this.signerAddress,
      ...req,
    });
    await this.sendAndConfirmTransaction(tx);
    return { ismAddress: req.ismAddress };
  }

  async setDefaultHook(
    req: Omit<AltVM.ReqSetDefaultHook, 'signer'>,
  ): Promise<AltVM.ResSetDefaultHook> {
    const tx = await this.getSetDefaultHookTransaction({
      signer: this.signerAddress,
      ...req,
    });
    await this.sendAndConfirmTransaction(tx);
    return { hookAddress: req.hookAddress };
  }

  async setRequiredHook(
    req: Omit<AltVM.ReqSetRequiredHook, 'signer'>,
  ): Promise<AltVM.ResSetRequiredHook> {
    const tx = await this.getSetRequiredHookTransaction({
      signer: this.signerAddress,
      ...req,
    });
    await this.sendAndConfirmTransaction(tx);
    return { hookAddress: req.hookAddress };
  }

  async setMailboxOwner(
    req: Omit<AltVM.ReqSetMailboxOwner, 'signer'>,
  ): Promise<AltVM.ResSetMailboxOwner> {
    const tx = await this.getSetMailboxOwnerTransaction({
      signer: this.signerAddress,
      ...req,
    });
    await this.sendAndConfirmTransaction(tx);
    return { newOwner: req.newOwner };
  }

  async createMerkleRootMultisigIsm(
    req: Omit<AltVM.ReqCreateMerkleRootMultisigIsm, 'signer'>,
  ): Promise<AltVM.ResCreateMerkleRootMultisigIsm> {
    const tx = await this.getCreateMerkleRootMultisigIsmTransaction({
      signer: this.signerAddress,
      ...req,
    });
    const receipt = await this.sendAndConfirmTransaction(tx);
    assert(receipt.contractAddress, 'failed to get Starknet ISM address');
    return { ismAddress: receipt.contractAddress };
  }

  async createMessageIdMultisigIsm(
    req: Omit<AltVM.ReqCreateMessageIdMultisigIsm, 'signer'>,
  ): Promise<AltVM.ResCreateMessageIdMultisigIsm> {
    const tx = await this.getCreateMessageIdMultisigIsmTransaction({
      signer: this.signerAddress,
      ...req,
    });
    const receipt = await this.sendAndConfirmTransaction(tx);
    assert(receipt.contractAddress, 'failed to get Starknet ISM address');
    return { ismAddress: receipt.contractAddress };
  }

  async createRoutingIsm(
    req: Omit<AltVM.ReqCreateRoutingIsm, 'signer'>,
  ): Promise<AltVM.ResCreateRoutingIsm> {
    const tx = await this.getCreateRoutingIsmTransaction({
      signer: this.signerAddress,
      ...req,
    });
    const receipt = await this.sendAndConfirmTransaction(tx);
    const ismAddress = receipt.contractAddress;
    assert(ismAddress, 'failed to get Starknet routing ISM address');

    for (const route of req.routes) {
      await this.setRoutingIsmRoute({ ismAddress, route });
    }

    return { ismAddress };
  }

  async setRoutingIsmRoute(
    req: Omit<AltVM.ReqSetRoutingIsmRoute, 'signer'>,
  ): Promise<AltVM.ResSetRoutingIsmRoute> {
    const tx = await this.getSetRoutingIsmRouteTransaction({
      signer: this.signerAddress,
      ...req,
    });
    await this.sendAndConfirmTransaction(tx);
    return { route: req.route };
  }

  async removeRoutingIsmRoute(
    req: Omit<AltVM.ReqRemoveRoutingIsmRoute, 'signer'>,
  ): Promise<AltVM.ResRemoveRoutingIsmRoute> {
    const tx = await this.getRemoveRoutingIsmRouteTransaction({
      signer: this.signerAddress,
      ...req,
    });
    await this.sendAndConfirmTransaction(tx);
    return { domainId: req.domainId };
  }

  async setRoutingIsmOwner(
    req: Omit<AltVM.ReqSetRoutingIsmOwner, 'signer'>,
  ): Promise<AltVM.ResSetRoutingIsmOwner> {
    const tx = await this.getSetRoutingIsmOwnerTransaction({
      signer: this.signerAddress,
      ...req,
    });
    await this.sendAndConfirmTransaction(tx);
    return { newOwner: req.newOwner };
  }

  async createNoopIsm(
    req: Omit<AltVM.ReqCreateNoopIsm, 'signer'>,
  ): Promise<AltVM.ResCreateNoopIsm> {
    const tx = await this.getCreateNoopIsmTransaction({
      signer: this.signerAddress,
      ...req,
    });
    const receipt = await this.sendAndConfirmTransaction(tx);
    assert(receipt.contractAddress, 'failed to get Starknet noop ISM address');
    return { ismAddress: receipt.contractAddress };
  }

  async createMerkleTreeHook(
    req: Omit<AltVM.ReqCreateMerkleTreeHook, 'signer'>,
  ): Promise<AltVM.ResCreateMerkleTreeHook> {
    const tx = await this.getCreateMerkleTreeHookTransaction({
      signer: this.signerAddress,
      ...req,
    });
    const receipt = await this.sendAndConfirmTransaction(tx);
    assert(receipt.contractAddress, 'failed to get Starknet hook address');
    return { hookAddress: receipt.contractAddress };
  }

  async createInterchainGasPaymasterHook(
    req: Omit<AltVM.ReqCreateInterchainGasPaymasterHook, 'signer'>,
  ): Promise<AltVM.ResCreateInterchainGasPaymasterHook> {
    const tx = await this.getCreateInterchainGasPaymasterHookTransaction({
      signer: this.signerAddress,
      ...req,
    });
    const receipt = await this.sendAndConfirmTransaction(tx);
    assert(receipt.contractAddress, 'failed to get Starknet protocol_fee hook');
    return { hookAddress: receipt.contractAddress };
  }

  async setInterchainGasPaymasterHookOwner(
    req: Omit<AltVM.ReqSetInterchainGasPaymasterHookOwner, 'signer'>,
  ): Promise<AltVM.ResSetInterchainGasPaymasterHookOwner> {
    const tx = await this.getSetInterchainGasPaymasterHookOwnerTransaction({
      signer: this.signerAddress,
      ...req,
    });
    await this.sendAndConfirmTransaction(tx);
    return { newOwner: req.newOwner };
  }

  async setDestinationGasConfig(
    req: Omit<AltVM.ReqSetDestinationGasConfig, 'signer'>,
  ): Promise<AltVM.ResSetDestinationGasConfig> {
    const tx = await this.getSetDestinationGasConfigTransaction({
      signer: this.signerAddress,
      ...req,
    });
    await this.sendAndConfirmTransaction(tx);
    return { destinationGasConfig: req.destinationGasConfig };
  }

  async removeDestinationGasConfig(
    req: Omit<AltVM.ReqRemoveDestinationGasConfig, 'signer'>,
  ): Promise<AltVM.ResRemoveDestinationGasConfig> {
    const tx = await this.getRemoveDestinationGasConfigTransaction({
      signer: this.signerAddress,
      ...req,
    });
    await this.sendAndConfirmTransaction(tx);
    return { remoteDomainId: req.remoteDomainId };
  }

  async createNoopHook(
    req: Omit<AltVM.ReqCreateNoopHook, 'signer'>,
  ): Promise<AltVM.ResCreateNoopHook> {
    const tx = await this.getCreateNoopHookTransaction({
      signer: this.signerAddress,
      ...req,
    });
    const receipt = await this.sendAndConfirmTransaction(tx);
    assert(receipt.contractAddress, 'failed to get Starknet noop hook');
    return { hookAddress: receipt.contractAddress };
  }

  async createValidatorAnnounce(
    req: Omit<AltVM.ReqCreateValidatorAnnounce, 'signer'>,
  ): Promise<AltVM.ResCreateValidatorAnnounce> {
    const tx = await this.getCreateValidatorAnnounceTransaction({
      signer: this.signerAddress,
      ...req,
    });
    const receipt = await this.sendAndConfirmTransaction(tx);
    assert(
      receipt.contractAddress,
      'failed to get Starknet validator announce address',
    );
    return { validatorAnnounceId: receipt.contractAddress };
  }

  async createProxyAdmin(
    _req: Omit<AltVM.ReqCreateProxyAdmin, 'signer'>,
  ): Promise<AltVM.ResCreateProxyAdmin> {
    throw new Error('Proxy admin unsupported on Starknet');
  }

  async setProxyAdminOwner(
    _req: Omit<AltVM.ReqSetProxyAdminOwner, 'signer'>,
  ): Promise<AltVM.ResSetProxyAdminOwner> {
    throw new Error('Proxy admin unsupported on Starknet');
  }

  // ### TX WARP ###

  async createNativeToken(
    req: Omit<AltVM.ReqCreateNativeToken, 'signer'>,
  ): Promise<AltVM.ResCreateNativeToken> {
    if (req.proxyAdminAddress) {
      throw new Error('Proxy admin unsupported on Starknet');
    }
    const tx = await this.getCreateNativeTokenTransaction({
      signer: this.signerAddress,
      ...req,
    });
    const receipt = await this.sendAndConfirmTransaction(tx);
    assert(receipt.contractAddress, 'failed to get Starknet warp token');
    return { tokenAddress: receipt.contractAddress };
  }

  async createCollateralToken(
    req: Omit<AltVM.ReqCreateCollateralToken, 'signer'>,
  ): Promise<AltVM.ResCreateCollateralToken> {
    if (req.proxyAdminAddress) {
      throw new Error('Proxy admin unsupported on Starknet');
    }
    const tx = await this.getCreateCollateralTokenTransaction({
      signer: this.signerAddress,
      ...req,
    });
    const receipt = await this.sendAndConfirmTransaction(tx);
    assert(receipt.contractAddress, 'failed to get Starknet warp token');
    return { tokenAddress: receipt.contractAddress };
  }

  async createSyntheticToken(
    req: Omit<AltVM.ReqCreateSyntheticToken, 'signer'>,
  ): Promise<AltVM.ResCreateSyntheticToken> {
    if (req.proxyAdminAddress) {
      throw new Error('Proxy admin unsupported on Starknet');
    }
    const tx = await this.getCreateSyntheticTokenTransaction({
      signer: this.signerAddress,
      ...req,
    });
    const receipt = await this.sendAndConfirmTransaction(tx);
    assert(receipt.contractAddress, 'failed to get Starknet warp token');
    return { tokenAddress: receipt.contractAddress };
  }

  async setTokenOwner(
    req: Omit<AltVM.ReqSetTokenOwner, 'signer'>,
  ): Promise<AltVM.ResSetTokenOwner> {
    const tx = await this.getSetTokenOwnerTransaction({
      signer: this.signerAddress,
      ...req,
    });
    await this.sendAndConfirmTransaction(tx);
    return { newOwner: req.newOwner };
  }

  async setTokenIsm(
    req: Omit<AltVM.ReqSetTokenIsm, 'signer'>,
  ): Promise<AltVM.ResSetTokenIsm> {
    const tx = await this.getSetTokenIsmTransaction({
      signer: this.signerAddress,
      ...req,
    });
    await this.sendAndConfirmTransaction(tx);
    return { ismAddress: req.ismAddress ?? ZERO_ADDRESS_HEX_32 };
  }

  async setTokenHook(
    req: Omit<AltVM.ReqSetTokenHook, 'signer'>,
  ): Promise<AltVM.ResSetTokenHook> {
    const tx = await this.getSetTokenHookTransaction({
      signer: this.signerAddress,
      ...req,
    });
    await this.sendAndConfirmTransaction(tx);
    return { hookAddress: req.hookAddress ?? ZERO_ADDRESS_HEX_32 };
  }

  async enrollRemoteRouter(
    req: Omit<AltVM.ReqEnrollRemoteRouter, 'signer'>,
  ): Promise<AltVM.ResEnrollRemoteRouter> {
    const tx = await this.getEnrollRemoteRouterTransaction({
      signer: this.signerAddress,
      ...req,
    });
    await this.sendAndConfirmTransaction(tx);
    return { receiverDomainId: req.remoteRouter.receiverDomainId };
  }

  async unenrollRemoteRouter(
    req: Omit<AltVM.ReqUnenrollRemoteRouter, 'signer'>,
  ): Promise<AltVM.ResUnenrollRemoteRouter> {
    const tx = await this.getUnenrollRemoteRouterTransaction({
      signer: this.signerAddress,
      ...req,
    });
    await this.sendAndConfirmTransaction(tx);
    return { receiverDomainId: req.receiverDomainId };
  }

  async transfer(
    req: Omit<AltVM.ReqTransfer, 'signer'>,
  ): Promise<AltVM.ResTransfer> {
    const tx = await this.getTransferTransaction({
      signer: this.signerAddress,
      ...req,
    });
    await this.sendAndConfirmTransaction(tx);
    return { recipient: req.recipient };
  }

  async remoteTransfer(
    req: Omit<AltVM.ReqRemoteTransfer, 'signer'>,
  ): Promise<AltVM.ResRemoteTransfer> {
    const tx = await this.getRemoteTransferTransaction({
      signer: this.signerAddress,
      ...req,
    });
    await this.sendAndConfirmTransaction(tx);
    return { tokenAddress: req.tokenAddress };
  }
}
