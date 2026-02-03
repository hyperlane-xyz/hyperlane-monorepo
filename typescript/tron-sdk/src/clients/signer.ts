import { TronWeb, Types } from 'tronweb';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { assert, strip0x } from '@hyperlane-xyz/utils';

import {
  TronSDKOptions,
  TronSDKReceipt,
  TronSDKTransaction,
} from '../utils/types.js';

import { TronProvider } from './provider.js';

// Default fee limit for contract deployments (1000 TRX)
const DEFAULT_FEE_LIMIT = 1_000_000_000;
// Default fee limit for contract calls (100 TRX)
const DEFAULT_CALL_FEE_LIMIT = 100_000_000;

/**
 * TronSigner extends TronProvider with transaction signing capabilities.
 * It can deploy contracts and execute contract methods.
 */
export class TronSigner
  extends TronProvider
  implements AltVM.ISigner<TronSDKTransaction, TronSDKReceipt>
{
  private signerAddress: string;

  private constructor(
    options: TronSDKOptions,
    privateKey: string,
    signerAddress: string,
  ) {
    super(options);
    this.signerAddress = signerAddress;

    // Set the private key on tronWeb for signing
    this.tronWeb.setPrivateKey(privateKey);
    this.tronWeb.setAddress(signerAddress);
  }

  static async connectWithSigner(
    rpcUrls: string[],
    privateKey: string,
    extraParams?: Record<string, unknown>,
  ): Promise<TronSigner> {
    assert(extraParams?.metadata, 'metadata required in extraParams');
    const metadata = extraParams.metadata as Record<string, unknown>;
    assert(metadata.chainId, 'chainId required in metadata');

    const chainId =
      typeof metadata.chainId === 'string'
        ? parseInt(metadata.chainId)
        : (metadata.chainId as number);

    // Create temporary TronWeb to derive address from private key
    const tempTronWeb = new TronWeb({ fullHost: rpcUrls[0] });
    const cleanPrivateKey = strip0x(privateKey);
    const signerAddress = tempTronWeb.address.fromPrivateKey(cleanPrivateKey);
    assert(signerAddress, 'Failed to derive address from private key');

    return new TronSigner({ rpcUrls, chainId }, cleanPrivateKey, signerAddress);
  }

  getSignerAddress(): string {
    return this.signerAddress;
  }

  supportsTransactionBatching(): boolean {
    return false;
  }

  async transactionToPrintableJson(
    transaction: TronSDKTransaction,
  ): Promise<object> {
    return {
      txID: transaction.transaction.txID,
      contractAddress: transaction.contractAddress,
      rawData: transaction.transaction.raw_data,
    };
  }

  async sendAndConfirmTransaction(
    transaction: TronSDKTransaction,
  ): Promise<TronSDKReceipt> {
    // Sign the transaction
    const signedTx = await this.tronWeb.trx.sign(transaction.transaction);

    // Broadcast
    const result = await this.tronWeb.trx.sendRawTransaction(signedTx);

    if (!result.result) {
      throw new Error(
        `Transaction failed: ${result.message || 'Unknown error'}`,
      );
    }

    // Wait for confirmation by polling for transaction info
    const txId = transaction.transaction.txID;
    const receipt = await this.waitForConfirmation(txId);

    return {
      txId,
      blockNumber: receipt.blockNumber,
      success: receipt.receipt?.result === 'SUCCESS',
      contractAddress: transaction.contractAddress,
      energyUsed: receipt.receipt?.energy_usage_total,
    };
  }

  async sendAndConfirmBatchTransactions(
    _transactions: TronSDKTransaction[],
  ): Promise<TronSDKReceipt> {
    throw new Error('Tron does not support transaction batching');
  }

  private async waitForConfirmation(
    txId: string,
    maxAttempts = 30,
    intervalMs = 2000,
  ): Promise<{
    blockNumber: number;
    receipt?: { result: string; energy_usage_total?: number };
  }> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const info = await this.tronWeb.trx.getTransactionInfo(txId);
        if (info && info.blockNumber) {
          return info;
        }
      } catch {
        // Transaction not yet confirmed
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(
      `Transaction ${txId} not confirmed after ${maxAttempts} attempts`,
    );
  }

  // Helper to deploy a contract
  private async deployContract(
    abi: Types.ContractAbiInterface,
    bytecode: string,
    constructorParams: unknown[] = [],
    name?: string,
  ): Promise<{ address: string; txId: string }> {
    const tx = await this.tronWeb.transactionBuilder.createSmartContract(
      {
        abi: { entrys: abi },
        bytecode,
        feeLimit: DEFAULT_FEE_LIMIT,
        callValue: 0,
        parameters: constructorParams,
        name: name?.slice(0, 32), // Tron 32-char limit
      },
      this.signerAddress,
    );

    const signedTx = await this.tronWeb.trx.sign(tx);
    const result = await this.tronWeb.trx.sendRawTransaction(signedTx);

    if (!result.result) {
      throw new Error(`Deploy failed: ${result.message || 'Unknown error'}`);
    }

    // Wait for confirmation to get the contract address
    await this.waitForConfirmation(tx.txID);

    // The contract address is returned in the transaction
    const contractAddress = this.tronWeb.address.fromHex(tx.contract_address);

    return { address: contractAddress, txId: tx.txID };
  }

  // Helper to call a contract method
  private async callContractMethod(
    contractAddress: string,
    functionSelector: string,
    parameters: { type: string; value: unknown }[] = [],
    callValue = 0,
  ): Promise<TronSDKReceipt> {
    const tx = await this.tronWeb.transactionBuilder.triggerSmartContract(
      contractAddress,
      functionSelector,
      {
        feeLimit: DEFAULT_CALL_FEE_LIMIT,
        callValue,
      },
      parameters,
      this.signerAddress,
    );

    if (!tx.result?.result) {
      throw new Error(
        `Contract call failed: ${tx.result?.message || 'Unknown error'}`,
      );
    }

    return this.sendAndConfirmTransaction({
      transaction: tx.transaction,
    });
  }

  // ============ Core Contract Operations ============

  async createMailbox(
    _req: Omit<AltVM.ReqCreateMailbox, 'signer'>,
  ): Promise<AltVM.ResCreateMailbox> {
    // Would need Mailbox ABI and bytecode
    // For now, throw - deployment requires compiled artifacts
    throw new Error(
      `Mailbox deployment requires compiled artifacts. Use deployContract() with ABI/bytecode.`,
    );
  }

  async setDefaultIsm(
    req: Omit<AltVM.ReqSetDefaultIsm, 'signer'>,
  ): Promise<AltVM.ResSetDefaultIsm> {
    await this.callContractMethod(
      req.mailboxAddress,
      'setDefaultIsm(address)',
      [{ type: 'address', value: req.ismAddress }],
    );
    return { ismAddress: req.ismAddress };
  }

  async setDefaultHook(
    req: Omit<AltVM.ReqSetDefaultHook, 'signer'>,
  ): Promise<AltVM.ResSetDefaultHook> {
    await this.callContractMethod(
      req.mailboxAddress,
      'setDefaultHook(address)',
      [{ type: 'address', value: req.hookAddress }],
    );
    return { hookAddress: req.hookAddress };
  }

  async setRequiredHook(
    req: Omit<AltVM.ReqSetRequiredHook, 'signer'>,
  ): Promise<AltVM.ResSetRequiredHook> {
    await this.callContractMethod(
      req.mailboxAddress,
      'setRequiredHook(address)',
      [{ type: 'address', value: req.hookAddress }],
    );
    return { hookAddress: req.hookAddress };
  }

  async setMailboxOwner(
    req: Omit<AltVM.ReqSetMailboxOwner, 'signer'>,
  ): Promise<AltVM.ResSetMailboxOwner> {
    await this.callContractMethod(
      req.mailboxAddress,
      'transferOwnership(address)',
      [{ type: 'address', value: req.newOwner }],
    );
    return { newOwner: req.newOwner };
  }

  async createMerkleRootMultisigIsm(
    _req: Omit<AltVM.ReqCreateMerkleRootMultisigIsm, 'signer'>,
  ): Promise<AltVM.ResCreateMerkleRootMultisigIsm> {
    throw new Error('ISM deployment requires compiled artifacts');
  }

  async createMessageIdMultisigIsm(
    _req: Omit<AltVM.ReqCreateMessageIdMultisigIsm, 'signer'>,
  ): Promise<AltVM.ResCreateMessageIdMultisigIsm> {
    throw new Error('ISM deployment requires compiled artifacts');
  }

  async createRoutingIsm(
    _req: Omit<AltVM.ReqCreateRoutingIsm, 'signer'>,
  ): Promise<AltVM.ResCreateRoutingIsm> {
    throw new Error('ISM deployment requires compiled artifacts');
  }

  async setRoutingIsmRoute(
    req: Omit<AltVM.ReqSetRoutingIsmRoute, 'signer'>,
  ): Promise<AltVM.ResSetRoutingIsmRoute> {
    await this.callContractMethod(req.ismAddress, 'set(uint32,address)', [
      { type: 'uint32', value: req.route.domainId },
      { type: 'address', value: req.route.ismAddress },
    ]);
    return { route: req.route };
  }

  async removeRoutingIsmRoute(
    req: Omit<AltVM.ReqRemoveRoutingIsmRoute, 'signer'>,
  ): Promise<AltVM.ResRemoveRoutingIsmRoute> {
    await this.callContractMethod(req.ismAddress, 'remove(uint32)', [
      { type: 'uint32', value: req.domainId },
    ]);
    return { domainId: req.domainId };
  }

  async setRoutingIsmOwner(
    req: Omit<AltVM.ReqSetRoutingIsmOwner, 'signer'>,
  ): Promise<AltVM.ResSetRoutingIsmOwner> {
    await this.callContractMethod(
      req.ismAddress,
      'transferOwnership(address)',
      [{ type: 'address', value: req.newOwner }],
    );
    return { newOwner: req.newOwner };
  }

  async createNoopIsm(
    _req: Omit<AltVM.ReqCreateNoopIsm, 'signer'>,
  ): Promise<AltVM.ResCreateNoopIsm> {
    throw new Error('ISM deployment requires compiled artifacts');
  }

  async createMerkleTreeHook(
    _req: Omit<AltVM.ReqCreateMerkleTreeHook, 'signer'>,
  ): Promise<AltVM.ResCreateMerkleTreeHook> {
    throw new Error('Hook deployment requires compiled artifacts');
  }

  async createInterchainGasPaymasterHook(
    _req: Omit<AltVM.ReqCreateInterchainGasPaymasterHook, 'signer'>,
  ): Promise<AltVM.ResCreateInterchainGasPaymasterHook> {
    throw new Error('Hook deployment requires compiled artifacts');
  }

  async setInterchainGasPaymasterHookOwner(
    req: Omit<AltVM.ReqSetInterchainGasPaymasterHookOwner, 'signer'>,
  ): Promise<AltVM.ResSetInterchainGasPaymasterHookOwner> {
    await this.callContractMethod(
      req.hookAddress,
      'transferOwnership(address)',
      [{ type: 'address', value: req.newOwner }],
    );
    return { newOwner: req.newOwner };
  }

  async setDestinationGasConfig(
    req: Omit<AltVM.ReqSetDestinationGasConfig, 'signer'>,
  ): Promise<AltVM.ResSetDestinationGasConfig> {
    await this.callContractMethod(
      req.hookAddress,
      'setDestinationGasConfigs((uint32,(address,uint96))[])',
      [
        {
          type: 'tuple[]',
          value: [
            [
              req.destinationGasConfig.remoteDomainId,
              [
                req.destinationGasConfig.gasOracle,
                req.destinationGasConfig.gasOverhead,
              ],
            ],
          ],
        },
      ],
    );
    return { destinationGasConfig: req.destinationGasConfig };
  }

  async removeDestinationGasConfig(
    _req: Omit<AltVM.ReqRemoveDestinationGasConfig, 'signer'>,
  ): Promise<AltVM.ResRemoveDestinationGasConfig> {
    throw new Error('Remove destination gas config not implemented');
  }

  async createNoopHook(
    _req: Omit<AltVM.ReqCreateNoopHook, 'signer'>,
  ): Promise<AltVM.ResCreateNoopHook> {
    throw new Error('Hook deployment requires compiled artifacts');
  }

  async createValidatorAnnounce(
    _req: Omit<AltVM.ReqCreateValidatorAnnounce, 'signer'>,
  ): Promise<AltVM.ResCreateValidatorAnnounce> {
    throw new Error('ValidatorAnnounce deployment requires compiled artifacts');
  }

  // ============ Warp Route Operations ============

  async createNativeToken(
    _req: Omit<AltVM.ReqCreateNativeToken, 'signer'>,
  ): Promise<AltVM.ResCreateNativeToken> {
    throw new Error('Token deployment requires compiled artifacts');
  }

  async createCollateralToken(
    _req: Omit<AltVM.ReqCreateCollateralToken, 'signer'>,
  ): Promise<AltVM.ResCreateCollateralToken> {
    throw new Error('Token deployment requires compiled artifacts');
  }

  async createSyntheticToken(
    _req: Omit<AltVM.ReqCreateSyntheticToken, 'signer'>,
  ): Promise<AltVM.ResCreateSyntheticToken> {
    throw new Error('Token deployment requires compiled artifacts');
  }

  async setTokenOwner(
    req: Omit<AltVM.ReqSetTokenOwner, 'signer'>,
  ): Promise<AltVM.ResSetTokenOwner> {
    await this.callContractMethod(
      req.tokenAddress,
      'transferOwnership(address)',
      [{ type: 'address', value: req.newOwner }],
    );
    return { newOwner: req.newOwner };
  }

  async setTokenIsm(
    req: Omit<AltVM.ReqSetTokenIsm, 'signer'>,
  ): Promise<AltVM.ResSetTokenIsm> {
    await this.callContractMethod(
      req.tokenAddress,
      'setInterchainSecurityModule(address)',
      [
        {
          type: 'address',
          value:
            req.ismAddress ??
            this.tronWeb.address.toHex('T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb'),
        },
      ], // Zero address
    );
    return { ismAddress: req.ismAddress ?? '' };
  }

  async setTokenHook(
    req: Omit<AltVM.ReqSetTokenHook, 'signer'>,
  ): Promise<AltVM.ResSetTokenHook> {
    await this.callContractMethod(req.tokenAddress, 'setHook(address)', [
      {
        type: 'address',
        value:
          req.hookAddress ??
          this.tronWeb.address.toHex('T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb'),
      },
    ]);
    return { hookAddress: req.hookAddress ?? '' };
  }

  async enrollRemoteRouter(
    req: Omit<AltVM.ReqEnrollRemoteRouter, 'signer'>,
  ): Promise<AltVM.ResEnrollRemoteRouter> {
    await this.callContractMethod(
      req.tokenAddress,
      'enrollRemoteRouter(uint32,bytes32)',
      [
        { type: 'uint32', value: req.remoteRouter.receiverDomainId },
        { type: 'bytes32', value: req.remoteRouter.receiverAddress },
      ],
    );
    return { receiverDomainId: req.remoteRouter.receiverDomainId };
  }

  async unenrollRemoteRouter(
    req: Omit<AltVM.ReqUnenrollRemoteRouter, 'signer'>,
  ): Promise<AltVM.ResUnenrollRemoteRouter> {
    await this.callContractMethod(
      req.tokenAddress,
      'unenrollRemoteRouter(uint32)',
      [{ type: 'uint32', value: req.receiverDomainId }],
    );
    return { receiverDomainId: req.receiverDomainId };
  }

  async transfer(
    req: Omit<AltVM.ReqTransfer, 'signer'>,
  ): Promise<AltVM.ResTransfer> {
    // Native TRX transfer
    const tx = await this.tronWeb.transactionBuilder.sendTrx(
      req.recipient,
      Number(req.amount),
      this.signerAddress,
    );
    await this.sendAndConfirmTransaction({ transaction: tx });
    return { recipient: req.recipient };
  }

  async remoteTransfer(
    req: Omit<AltVM.ReqRemoteTransfer, 'signer'>,
  ): Promise<AltVM.ResRemoteTransfer> {
    // Quote the gas payment first
    const quote = await this.quoteRemoteTransfer({
      tokenAddress: req.tokenAddress,
      destinationDomainId: req.destinationDomainId,
    });

    await this.callContractMethod(
      req.tokenAddress,
      'transferRemote(uint32,bytes32,uint256)',
      [
        { type: 'uint32', value: req.destinationDomainId },
        { type: 'bytes32', value: req.recipient },
        { type: 'uint256', value: req.amount.toString() },
      ],
      Number(quote.amount), // callValue for gas payment
    );

    return { tokenAddress: req.tokenAddress };
  }

  // ============ Direct Contract Deployment ============

  /**
   * Deploy a contract with ABI and bytecode.
   * This is the low-level method used by higher-level deployment functions.
   */
  async deployContractWithArtifacts(params: {
    abi: Types.ContractAbiInterface;
    bytecode: string;
    constructorParams?: unknown[];
    name?: string;
  }): Promise<{ address: string; txId: string }> {
    return this.deployContract(
      params.abi,
      params.bytecode,
      params.constructorParams ?? [],
      params.name,
    );
  }
}
