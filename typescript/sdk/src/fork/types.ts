import { z } from 'zod';

import { objMap, objMerge } from '@hyperlane-xyz/utils';

import { ZHash } from '../metadata/customZodTypes.js';

export enum EventAssertionType {
  RAW_TOPIC = 'rawTopic',
  TOPIC_SIGNATURE = 'topicSignature',
}

export const EventAssertionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal(EventAssertionType.RAW_TOPIC),
    topic: ZHash,
    annotation: z.string().optional(),
  }),
  z.object({
    type: z.literal(EventAssertionType.TOPIC_SIGNATURE),
    signature: z.string(),
    args: z.array(z.string()).optional(),
    annotation: z.string().optional(),
  }),
]);

export type EventAssertion = z.infer<typeof EventAssertionSchema>;

export enum TransactionDataType {
  RAW_CALLDATA = 'rawCalldata',
  SIGNATURE = 'signature',
}

const TransactionDataSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal(TransactionDataType.RAW_CALLDATA),
    calldata: ZHash,
  }),
  z.object({
    type: z.literal(TransactionDataType.SIGNATURE),
    signature: z.string(),
    args: z.array(z.string()).default([]),
  }),
]);

export const ForkedChainTransactionConfigSchema = z.object({
  annotation: z.string().optional(),
  from: ZHash,
  data: TransactionDataSchema.optional(),
  value: z.string().optional(),
  to: ZHash.optional(),
  timeSkip: z.number().optional(),
  eventAssertions: z.array(EventAssertionSchema).default([]),
});
export type ForkedChainTransactionConfig = z.infer<
  typeof ForkedChainTransactionConfigSchema
>;

export const ForkedChainConfigSchema = z.object({
  impersonateAccounts: z.array(ZHash).default([]),
  transactions: z.array(ForkedChainTransactionConfigSchema).default([]),
});

export type ForkedChainConfig = z.infer<typeof ForkedChainConfigSchema>;

export const ForkedChainConfigByChainSchema = z.record(ForkedChainConfigSchema);
export type ForkedChainConfigByChain = z.infer<
  typeof ForkedChainConfigByChainSchema
>;

export enum TransactionConfigType {
  RAW_TRANSACTION = 'rawTransaction',
  FILE = 'file',
}

export const RawForkedChainTransactionConfigSchema = z.discriminatedUnion(
  'type',
  [
    z.object({
      type: z.literal(TransactionConfigType.RAW_TRANSACTION),
      transactions: z.array(ForkedChainTransactionConfigSchema),
    }),
    z.object({
      type: z.literal(TransactionConfigType.FILE),
      path: z.string(),
      defaultSender: ZHash,
      overrides: z
        .record(ForkedChainTransactionConfigSchema.partial())
        .default({}),
    }),
  ],
);
export type RawForkedChainTransactionConfig = z.infer<
  typeof RawForkedChainTransactionConfigSchema
>;

export const RawForkedChainConfigSchema = z.object({
  impersonateAccounts: z.array(ZHash).default([]),
  transactions: z.array(RawForkedChainTransactionConfigSchema),
});

export type RawForkedChainConfig = z.infer<typeof RawForkedChainConfigSchema>;
export const RawForkedChainConfigByChainSchema = z.record(
  RawForkedChainConfigSchema,
);
export type RawForkedChainConfigByChain = z.infer<
  typeof RawForkedChainConfigByChainSchema
>;

export const SafeTxFileSchema = z.object({
  version: z.string(),
  chainId: z.string(),
  transactions: z.array(
    ForkedChainTransactionConfigSchema.pick({
      value: true,
      to: true,
    }).extend({
      data: z.string().optional(),
    }),
  ),
});
export type SafeTx = z.infer<typeof SafeTxFileSchema>;

type TxFormatter = {
  [Key in TransactionConfigType]: (
    config: Extract<RawForkedChainTransactionConfig, { type: Key }>,
  ) => ReadonlyArray<ForkedChainTransactionConfig>;
};

function forkedChainTransactionsFromRaw(
  raw: RawForkedChainTransactionConfig,
  fileReader: <T>(path: string) => T,
): ReadonlyArray<ForkedChainTransactionConfig> {
  const formatters: TxFormatter = {
    [TransactionConfigType.FILE]: (config) => {
      const safeTxs: SafeTx = fileReader(config.path);

      const transactions = safeTxs.transactions.map(
        (safeTx, idx): ForkedChainTransactionConfig => {
          const overrides = config.overrides[idx] ?? {};

          const baseTx: ForkedChainTransactionConfig = {
            from: config.defaultSender,
            data: {
              type: TransactionDataType.RAW_CALLDATA,
              calldata: safeTx.data ?? '0x',
            },
            to: safeTx.to,
            value: safeTx.value,
            eventAssertions: [],
          };

          return objMerge(baseTx, overrides);
        },
      );

      return transactions;
    },
    [TransactionConfigType.RAW_TRANSACTION]: (config) => config.transactions,
  };

  const formatter = formatters[raw.type];

  // TODO: fix the error
  if (!formatter) {
    throw new Error('henlo');
  }

  // @ts-ignore
  return formatter(raw);
}

function forkedChainConfigFromRaw(
  raw: RawForkedChainConfig,
  fileReader: <T>(path: string) => T,
): ForkedChainConfig {
  const parsedRawConfig = RawForkedChainConfigSchema.parse(raw);

  const transactions = raw.transactions.flatMap((transactions) =>
    forkedChainTransactionsFromRaw(transactions, fileReader),
  );
  const transactionSenders = transactions.map((tx) => tx.from);

  const impersonateAccounts = Array.from(
    new Set([...transactionSenders, ...parsedRawConfig.impersonateAccounts]),
  );

  const forkedChainConfig: ForkedChainConfig = {
    transactions,
    impersonateAccounts,
  };

  return ForkedChainConfigSchema.parse(forkedChainConfig);
}

export function forkedChainConfigByChainFromRaw(
  raw: RawForkedChainConfigByChain,
  fileReader: <T>(path: string) => T,
): ForkedChainConfigByChain {
  const forkConfigByChain = objMap(raw, (_chain, config) =>
    forkedChainConfigFromRaw(config, fileReader),
  );

  return ForkedChainConfigByChainSchema.parse(forkConfigByChain);
}
