import {
  Account,
  Call,
  CallData,
  GetTransactionReceiptResponse,
  RawArgs,
  RpcProvider,
  legacyDeployer,
} from 'starknet';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk/chain';
import { ContractType } from '@hyperlane-xyz/starknet-core/runtime';
import { assert } from '@hyperlane-xyz/utils';

import {
  StarknetContractName,
  getStarknetContract,
  normalizeStarknetAddressSafe,
  populateInvokeTx,
  toBigInt,
} from '../contracts.js';
import {
  StarknetAnnotatedTx,
  StarknetInvokeTx,
  StarknetTxReceipt,
} from '../types.js';

import { StarknetProvider } from './provider.js';

export class StarknetSigner
  extends StarknetProvider
  implements AltVM.ISigner<StarknetAnnotatedTx, StarknetTxReceipt>
{
  static async connectWithSigner(
    metadata: ChainMetadataForAltVM,
    privateKey: string,
    extraParams?: {
      accountAddress?: string;
    },
  ): Promise<StarknetSigner> {
    const accountAddress = extraParams?.accountAddress;
    assert(accountAddress, 'accountAddress missing for Starknet signer');
    assert(privateKey, 'private key missing for Starknet signer');

    const rpcUrls = (metadata.rpcUrls ?? []).map(({ http }) => http);
    const provider = StarknetProvider.connect(metadata);

    return new StarknetSigner(
      provider.getRawProvider(),
      metadata,
      rpcUrls,
      normalizeStarknetAddressSafe(accountAddress),
      privateKey,
    );
  }

  private readonly account: Account;

  protected constructor(
    provider: RpcProvider,
    metadata: ChainMetadataForAltVM,
    rpcUrls: string[],
    private readonly signerAddress: string,
    privateKey: string,
  ) {
    super(provider, metadata, rpcUrls);
    this.account = new Account({
      provider,
      address: signerAddress,
      signer: privateKey,
      // The legacy UDC remains deployed across old devnets and production
      // networks. starknet.js v8's new default UDC is unavailable on older
      // networks that this SDK still supports.
      deployer: legacyDeployer,
    });
  }

  protected override get accountAddress(): string {
    return this.signerAddress;
  }

  getSignerAddress(): string {
    return this.signerAddress;
  }

  supportsTransactionBatching(): boolean {
    return true;
  }

  async transactionToPrintableJson(
    transaction: StarknetAnnotatedTx,
  ): Promise<object> {
    return transaction;
  }

  private assertSuccessfulReceipt(
    transactionHash: string,
    receipt: GetTransactionReceiptResponse,
  ): void {
    if (receipt.isSuccess()) return;

    if (receipt.isReverted()) {
      const receiptValue = receipt.value;
      const revertReason =
        typeof receiptValue === 'object' &&
        typeof Reflect.get(receiptValue, 'revert_reason') === 'string'
          ? Reflect.get(receiptValue, 'revert_reason')
          : undefined;
      const details =
        typeof revertReason === 'string' && revertReason.length > 0
          ? `: ${revertReason}`
          : '';
      assert(
        false,
        `Starknet transaction ${transactionHash} reverted${details}`,
      );
    }

    if (receipt.isError()) {
      assert(
        false,
        `Starknet transaction ${transactionHash} failed: ${receipt.value.message}`,
      );
    }

    assert(
      false,
      `Starknet transaction ${transactionHash} failed with an unknown status`,
    );
  }

  private async deployContract(params: {
    contractName: string;
    constructorArgs: RawArgs;
    contractType?: ContractType;
  }): Promise<{
    transactionHash: string;
    contractAddress: string;
    receipt: GetTransactionReceiptResponse;
  }> {
    const { getCompiledContract, getContractArtifact } =
      await import('@hyperlane-xyz/starknet-core');
    const compiledContract = getCompiledContract(
      params.contractName,
      params.contractType,
    );
    const contractArtifact = getContractArtifact(
      params.contractName,
      params.contractType,
    );
    assert(
      contractArtifact.compiled_contract_class,
      `Missing compiled_contract_class for Starknet contract ${params.contractName}`,
    );
    const hasConstructor = compiledContract.abi.some(
      (item) => item.type === 'constructor',
    );
    const constructorCalldata = hasConstructor
      ? new CallData(compiledContract.abi).compile(
          'constructor',
          params.constructorArgs,
        )
      : undefined;

    const { deploy } = await this.account.declareAndDeploy({
      contract: compiledContract,
      casm: contractArtifact.compiled_contract_class,
      constructorCalldata,
    });

    const transactionHash = deploy.transaction_hash;
    assert(transactionHash, 'missing Starknet deploy transaction hash');

    const rawAddress = deploy.contract_address;
    assert(rawAddress, 'missing Starknet deploy contract address');

    const address = normalizeStarknetAddressSafe(rawAddress);
    const receipt = await this.account.waitForTransaction(transactionHash);
    this.assertSuccessfulReceipt(transactionHash, receipt);

    return {
      transactionHash,
      contractAddress: address,
      receipt,
    };
  }

  async sendAndConfirmTransaction(
    transaction: StarknetAnnotatedTx,
  ): Promise<StarknetTxReceipt> {
    if (transaction.kind === 'deploy') {
      const deployed = await this.deployContract({
        contractName: transaction.contractName,
        constructorArgs: transaction.constructorArgs,
        contractType: transaction.contractType,
      });

      return {
        transactionHash: deployed.transactionHash,
        contractAddress: deployed.contractAddress,
        receipt: deployed.receipt,
      };
    }

    const calls: Call[] = transaction.calls ?? [
      {
        contractAddress: transaction.contractAddress,
        entrypoint: transaction.entrypoint,
        calldata: transaction.calldata,
      },
    ];

    const response = await this.account.execute(calls);
    const transactionHash = response.transaction_hash;
    const receipt = await this.account.waitForTransaction(transactionHash);
    this.assertSuccessfulReceipt(transactionHash, receipt);

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

    const invokeTransactions = transactions.filter(
      (tx): tx is StarknetInvokeTx => tx.kind === 'invoke',
    );
    assert(
      invokeTransactions.length === transactions.length,
      'Batch transactions with non-invoke operations are unsupported on Starknet signer',
    );

    const calls: Call[] = invokeTransactions.flatMap(
      (invoke) =>
        invoke.calls ?? [
          {
            contractAddress: invoke.contractAddress,
            entrypoint: invoke.entrypoint,
            calldata: invoke.calldata,
          },
        ],
    );

    const response = await this.account.execute(calls);
    const transactionHash = response.transaction_hash;
    const receipt = await this.account.waitForTransaction(transactionHash);
    this.assertSuccessfulReceipt(transactionHash, receipt);
    return { transactionHash, receipt };
  }

  override async estimateTransactionFee(
    req: AltVM.ReqEstimateTransactionFee<StarknetAnnotatedTx>,
  ): Promise<AltVM.ResEstimateTransactionFee> {
    assert(
      req.transaction.kind === 'invoke',
      'Starknet transaction fee estimation only supports invoke transactions',
    );

    const calls: Call[] = req.transaction.calls ?? [
      {
        contractAddress: req.transaction.contractAddress,
        entrypoint: req.transaction.entrypoint,
        calldata: req.transaction.calldata,
      },
    ];

    const estimate = await this.account.estimateInvokeFee(calls);
    const { l1_gas, l1_data_gas, l2_gas } = estimate.resourceBounds;
    const gasUnits =
      l1_gas.max_amount + l1_data_gas.max_amount + l2_gas.max_amount;

    return {
      gasUnits,
      gasPrice: Number(l1_gas.max_price_per_unit),
      fee: estimate.overall_fee,
    };
  }

  async remoteTransfer(
    req: Omit<AltVM.ReqRemoteTransfer, 'signer'>,
  ): Promise<AltVM.ResRemoteTransfer> {
    const token = await this.getToken({ tokenAddress: req.tokenAddress });
    const tokenType = token.tokenType;
    const tx = await this.buildRemoteTransferTransaction(
      {
        signer: this.signerAddress,
        ...req,
      },
      token,
    );
    const batchedTxs: StarknetAnnotatedTx[] = [];

    if (tokenType === AltVM.TokenType.native) {
      const nativeToken = getStarknetContract(
        StarknetContractName.ETHER,
        token.denom,
        this.provider,
        ContractType.TOKEN,
      );
      batchedTxs.push(
        await populateInvokeTx(nativeToken, 'approve', [
          normalizeStarknetAddressSafe(req.tokenAddress),
          toBigInt(req.amount) + toBigInt(req.maxFee.amount),
        ]),
      );
    } else if (tokenType === AltVM.TokenType.collateral) {
      const collateralToken = getStarknetContract(
        StarknetContractName.ETHER,
        token.denom,
        this.provider,
        ContractType.TOKEN,
      );
      const collateralDenom = normalizeStarknetAddressSafe(token.denom);
      const feeDenom = normalizeStarknetAddressSafe(req.maxFee.denom);
      const approvalAmount =
        collateralDenom === feeDenom
          ? toBigInt(req.amount) + toBigInt(req.maxFee.amount)
          : toBigInt(req.amount);
      batchedTxs.push(
        await populateInvokeTx(collateralToken, 'approve', [
          normalizeStarknetAddressSafe(req.tokenAddress),
          approvalAmount,
        ]),
      );
    }

    const usesSharedCollateralAndFeeToken =
      tokenType === AltVM.TokenType.collateral &&
      normalizeStarknetAddressSafe(token.denom) ===
        normalizeStarknetAddressSafe(req.maxFee.denom);

    if (
      tokenType !== AltVM.TokenType.native &&
      !usesSharedCollateralAndFeeToken
    ) {
      const feeToken = getStarknetContract(
        StarknetContractName.ETHER,
        req.maxFee.denom,
        this.provider,
        ContractType.TOKEN,
      );
      batchedTxs.push(
        await populateInvokeTx(feeToken, 'approve', [
          normalizeStarknetAddressSafe(req.tokenAddress),
          toBigInt(req.maxFee.amount),
        ]),
      );
    }

    if (batchedTxs.length > 0) {
      await this.sendAndConfirmBatchTransactions([...batchedTxs, tx]);
    } else {
      await this.sendAndConfirmTransaction(tx);
    }
    return { tokenAddress: req.tokenAddress };
  }
}
