import { confirm } from '@inquirer/prompts';
import { BigNumber, type Signer, utils as ethersUtils } from 'ethers';
import { stringify as yamlStringify } from 'yaml';
import { z } from 'zod';

import {
  type AnnotatedEV5Transaction,
  type ChainName,
  EV5JsonRpcSubmissionError,
  EV5JsonRpcTxSubmitter,
} from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  assert,
  eqAddress,
  errorToString,
  isValidAddressEvm,
} from '@hyperlane-xyz/utils';

import {
  type CommandContext,
  type WriteCommandContext,
} from '../context/types.js';
import { getSubmitterByStrategy } from '../deploy/warp.js';
import { logGray, logRed, logTable } from '../logger.js';
import {
  indentYamlOrJson,
  readYamlOrJson,
  writeYamlOrJson,
} from '../utils/files.js';

export async function runSubmit({
  context,
  chain,
  transactions,
  receiptsFilepath,
  strategyPath,
}: {
  context: WriteCommandContext;
  chain: ChainName;
  transactions: AnnotatedEV5Transaction[];
  receiptsFilepath: string;
  strategyPath?: string;
}) {
  const { submitter } = await getSubmitterByStrategy<ProtocolType>({
    chain,
    context,
    strategyUrl: strategyPath,
  });

  try {
    const transactionReceipts = await submitter.submit(...transactions);
    if (transactionReceipts) {
      logGray(
        '🧾 Transaction receipts:\n\n',
        indentYamlOrJson(yamlStringify(transactionReceipts, null, 2), 4),
      );
      const receiptPath = `${receiptsFilepath}/${chain}-${
        submitter.txSubmitterType
      }-${Date.now()}-receipts.json`;
      writeYamlOrJson(receiptPath, transactionReceipts, 'json');
    }
  } catch (error) {
    logRed(
      `⛔️ Failed to submit ${transactions.length} transactions:`,
      errorToString(error),
    );
    throw new Error('Failed to submit transactions.');
  }
}

interface ExternalSubmissionPlan {
  chain: ChainName;
  transactions: AnnotatedEV5Transaction[];
  signerAddress: string;
  balance: BigNumber;
  requiredBalance: BigNumber;
}

const ExternalBigNumberSchema = z
  .union([
    z.number().int().safe().nonnegative(),
    z.string().regex(/^(?:0x[0-9a-fA-F]+|[0-9]+)$/),
  ])
  .transform((value) => BigNumber.from(value))
  .refine((value) => !value.isNegative(), 'Value must be non-negative');

const EvmAddressSchema = z
  .string()
  .refine(isValidAddressEvm, 'Invalid EVM address');
const EvmDataSchema = z
  .string()
  .regex(/^0x(?:[0-9a-fA-F]{2})*$/, 'Invalid EVM transaction data');
const StorageKeySchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'Invalid access-list storage key');
const AccessListRecordSchema = z
  .record(z.array(StorageKeySchema))
  .refine(
    (accessList) => Object.keys(accessList).every(isValidAddressEvm),
    'Invalid access-list address',
  );
const AccessListSchema = z
  .union([
    z.array(
      z
        .object({
          address: EvmAddressSchema,
          storageKeys: z.array(StorageKeySchema),
        })
        .strict(),
    ),
    z.array(z.tuple([EvmAddressSchema, z.array(StorageKeySchema)])),
    AccessListRecordSchema,
  ])
  .transform((accessList) => ethersUtils.accessListify(accessList));

const ExternalTransactionSchema = z
  .object({
    accessList: AccessListSchema.optional(),
    annotation: z.string().optional(),
    chainId: z.number().int().safe().positive(),
    data: EvmDataSchema.optional(),
    from: EvmAddressSchema.optional(),
    gasLimit: ExternalBigNumberSchema.optional(),
    gasPrice: ExternalBigNumberSchema.optional(),
    maxFeePerGas: ExternalBigNumberSchema.optional(),
    maxPriorityFeePerGas: ExternalBigNumberSchema.optional(),
    nonce: z.number().int().safe().nonnegative().optional(),
    to: EvmAddressSchema.optional(),
    type: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
    value: ExternalBigNumberSchema.optional(),
  })
  .strict()
  .superRefine((transaction, context) => {
    if (
      transaction.gasPrice !== undefined &&
      (transaction.maxFeePerGas !== undefined ||
        transaction.maxPriorityFeePerGas !== undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'gasPrice cannot be combined with EIP-1559 fee fields',
      });
    }
    if (
      transaction.maxFeePerGas !== undefined &&
      transaction.maxPriorityFeePerGas?.gt(transaction.maxFeePerGas)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'maxPriorityFeePerGas cannot exceed maxFeePerGas',
      });
    }
    if (
      transaction.type === 0 &&
      (transaction.accessList !== undefined ||
        transaction.maxFeePerGas !== undefined ||
        transaction.maxPriorityFeePerGas !== undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Type 0 transactions cannot use access lists or EIP-1559 fees',
      });
    }
    if (
      transaction.type === 1 &&
      (transaction.maxFeePerGas !== undefined ||
        transaction.maxPriorityFeePerGas !== undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Type 1 transactions cannot use EIP-1559 fee fields',
      });
    }
    if (transaction.type === 2 && transaction.gasPrice !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Type 2 transactions cannot use gasPrice',
      });
    }
  });

export function validateExternalTransactions(
  transactions: unknown[],
): AnnotatedEV5Transaction[] {
  return z.array(ExternalTransactionSchema).min(1).parse(transactions);
}

export async function runExternalSubmit({
  context,
  signer,
  transactions,
  receiptsFilepath,
}: {
  context: Pick<CommandContext, 'multiProvider' | 'skipConfirmation'>;
  signer: Signer;
  transactions: unknown[];
  receiptsFilepath: string;
}): Promise<void> {
  const validatedTransactions = validateExternalTransactions(transactions);
  const plans = await prepareExternalSubmission({
    context,
    signer,
    transactions: validatedTransactions,
  });

  logGray('External signer submission plan');
  logTable(
    plans.flatMap((plan) =>
      plan.transactions.map((tx) => ({
        chain: plan.chain,
        signer: plan.signerAddress,
        target: tx.to ?? '(contract creation)',
        selector:
          typeof tx.data === 'string' && tx.data.length >= 10
            ? tx.data.slice(0, 10)
            : '(none)',
        value: BigNumber.from(tx.value ?? 0).toString(),
      })),
    ),
  );

  if (!context.skipConfirmation) {
    const confirmed = await confirm({
      message: `Submit ${validatedTransactions.length} transaction(s) with the external signer?`,
      default: false,
    });
    assert(confirmed, 'Transaction submission cancelled');
  }

  for (const plan of plans) {
    const submitter = new EV5JsonRpcTxSubmitter(
      context.multiProvider,
      { chain: plan.chain },
      signer,
    );

    try {
      const receipts = await submitter.submit(...plan.transactions);
      writeSubmissionResults(receiptsFilepath, plan.chain, 'jsonRpc', receipts);
    } catch (error) {
      if (
        error instanceof EV5JsonRpcSubmissionError &&
        error.submittedTransactions.length > 0
      ) {
        writeSubmissionResults(
          receiptsFilepath,
          plan.chain,
          'jsonRpc-partial',
          error.submittedTransactions,
        );
      }
      throw error;
    }
  }
}

export async function prepareExternalSubmission({
  context,
  signer,
  transactions,
}: {
  context: Pick<CommandContext, 'multiProvider'>;
  signer: Signer;
  transactions: AnnotatedEV5Transaction[];
}): Promise<ExternalSubmissionPlan[]> {
  assert(transactions.length > 0, 'No transactions found in file');
  const signerAddress = await signer.getAddress();
  const transactionsByChain = new Map<ChainName, AnnotatedEV5Transaction[]>();

  // Resolve and validate the complete input before any RPC preflight or send.
  for (const transaction of transactions) {
    assert(
      transaction.chainId !== undefined,
      'Invalid transaction: missing chainId',
    );
    const chain = context.multiProvider.getChainName(transaction.chainId);
    assert(
      context.multiProvider.getProtocol(chain) === ProtocolType.Ethereum,
      `External EVM signers cannot submit transactions on ${chain}`,
    );
    if (transaction.from) {
      assert(
        eqAddress(transaction.from, signerAddress),
        `Transaction sender ${transaction.from} does not match external signer ${signerAddress} on ${chain}`,
      );
    }

    const chainTransactions = transactionsByChain.get(chain) ?? [];
    chainTransactions.push(transaction);
    transactionsByChain.set(chain, chainTransactions);
  }

  return Promise.all(
    Array.from(transactionsByChain, async ([chain, chainTransactions]) => {
      const provider = context.multiProvider.getProvider(chain);
      const [feeData, balance] = await Promise.all([
        provider.getFeeData(),
        provider.getBalance(signerAddress),
      ]);

      let requiredBalance = BigNumber.from(0);
      for (const [
        transactionIndex,
        transaction,
      ] of chainTransactions.entries()) {
        const { annotation: _annotation, ...populatedTransaction } =
          transaction;
        const preparedTransaction = await context.multiProvider.prepareTx(
          chain,
          populatedTransaction,
          signerAddress,
        );
        let estimatedGas: BigNumber;
        try {
          // Preflight does not mutate state; every transaction must stand alone.
          estimatedGas = await context.multiProvider.estimateGas(
            chain,
            populatedTransaction,
            signerAddress,
          );
        } catch (error) {
          throw new Error(
            `Transaction ${transactionIndex + 1} on ${chain} cannot be estimated independently against current on-chain state. Split state-dependent transactions into separate submit runs: ${errorToString(error)}`,
            { cause: error },
          );
        }
        if (preparedTransaction.gasLimit !== undefined) {
          assert(
            BigNumber.from(preparedTransaction.gasLimit).gte(estimatedGas),
            `Transaction gas limit is below the estimate on ${chain}`,
          );
        }
        const gasLimit = preparedTransaction.gasLimit ?? estimatedGas;
        const maxFeePerGas =
          preparedTransaction.maxFeePerGas ??
          preparedTransaction.gasPrice ??
          feeData.maxFeePerGas ??
          feeData.gasPrice;
        assert(maxFeePerGas, `Could not determine gas price for ${chain}`);
        requiredBalance = requiredBalance
          .add(BigNumber.from(gasLimit).mul(maxFeePerGas))
          .add(preparedTransaction.value ?? 0);
      }

      assert(
        balance.gte(requiredBalance),
        `External signer ${signerAddress} has insufficient balance on ${chain}: requires at least ${requiredBalance.toString()} wei, found ${balance.toString()} wei`,
      );

      return {
        chain,
        transactions: chainTransactions,
        signerAddress,
        balance,
        requiredBalance,
      };
    }),
  );
}

function writeSubmissionResults(
  receiptsFilepath: string,
  chain: ChainName,
  label: string,
  results: unknown[],
): void {
  logGray(
    '🧾 Transaction results:\n\n',
    indentYamlOrJson(yamlStringify(results, null, 2), 4),
  );
  const receiptPath = `${receiptsFilepath}/${chain}-${label}-${Date.now()}-receipts.json`;
  writeYamlOrJson(receiptPath, results, 'json');
}

export function getTransactions(
  transactionsFilepath: string,
): AnnotatedEV5Transaction[] {
  const transactions = readYamlOrJson<unknown>(transactionsFilepath.trim());
  assert(
    Array.isArray(transactions),
    'Transactions file must contain an array',
  );
  assert(
    transactions.every(isAnnotatedEvmTransaction),
    'Transactions file contains an invalid EVM transaction',
  );
  return transactions;
}

function isAnnotatedEvmTransaction(
  value: unknown,
): value is AnnotatedEV5Transaction {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  if (!('chainId' in value) || typeof value.chainId !== 'number') return false;
  if ('from' in value && value.from != null && typeof value.from !== 'string')
    return false;
  if ('to' in value && value.to != null && typeof value.to !== 'string')
    return false;
  if ('data' in value && value.data != null && typeof value.data !== 'string')
    return false;
  return true;
}
