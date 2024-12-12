import { IRegistry } from '@hyperlane-xyz/registry';
import {
  AnnotatedEV5Transaction,
  ChainName,
  ChainSubmissionStrategy,
  ChainSubmissionStrategySchema,
  EV5GnosisSafeTxBuilder,
  EV5GnosisSafeTxSubmitter,
  EV5ImpersonatedAccountTxSubmitter,
  EV5JsonRpcTxSubmitter,
  EvmIcaTxSubmitter,
  MultiProvider,
  SubmissionStrategy,
  SubmissionStrategySchema,
  SubmitterMetadata,
  TxSubmitterBuilder,
  TxSubmitterInterface,
  TxSubmitterType,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  ProtocolType,
  objMap,
  promiseObjAll,
  retryAsync,
} from '@hyperlane-xyz/utils';

import { WriteCommandContext } from '../context/types.js';
import { logGreen } from '../logger.js';
import { readYamlOrJson, writeYamlOrJson } from '../utils/files.js';
import { canSelfRelay, runSelfRelay } from '../utils/relay.js';

import { SubmitterBuilderSettings } from './types.js';

export async function getSubmitterBuilder<TProtocol extends ProtocolType>({
  submissionStrategy,
  multiProvider,
  registry,
}: SubmitterBuilderSettings): Promise<TxSubmitterBuilder<TProtocol>> {
  const submitter = await getSubmitter<TProtocol>(
    multiProvider,
    submissionStrategy.submitter,
    registry,
  );

  return new TxSubmitterBuilder<TProtocol>(submitter, []);
}

async function getSubmitter<TProtocol extends ProtocolType>(
  multiProvider: MultiProvider,
  submitterMetadata: SubmitterMetadata,
  registry: IRegistry,
): Promise<TxSubmitterInterface<TProtocol>> {
  let interchainAccountRouterAddress: Address | undefined;
  if (submitterMetadata.type === TxSubmitterType.INTERCHAIN_ACCOUNT) {
    const metadata = await registry.getChainAddresses(submitterMetadata.chain);

    interchainAccountRouterAddress =
      submitterMetadata.originInterchainAccountRouter ??
      metadata?.interchainAccountRouter;
  }

  switch (submitterMetadata.type) {
    case TxSubmitterType.JSON_RPC:
      return new EV5JsonRpcTxSubmitter(multiProvider, {
        ...submitterMetadata,
      });
    case TxSubmitterType.IMPERSONATED_ACCOUNT:
      return new EV5ImpersonatedAccountTxSubmitter(multiProvider, {
        ...submitterMetadata,
      });
    case TxSubmitterType.GNOSIS_SAFE:
      return EV5GnosisSafeTxSubmitter.create(multiProvider, {
        ...submitterMetadata,
      });
    case TxSubmitterType.GNOSIS_TX_BUILDER:
      return EV5GnosisSafeTxBuilder.create(multiProvider, {
        ...submitterMetadata,
      });
    case TxSubmitterType.INTERCHAIN_ACCOUNT:
      if (!interchainAccountRouterAddress) {
        throw new Error(
          `Origin chain InterchainAccountRouter address not supplied and none found in the registry metadata for chain ${submitterMetadata.chain}`,
        );
      }

      return EvmIcaTxSubmitter.fromConfig(
        {
          ...submitterMetadata,
          originInterchainAccountRouter: interchainAccountRouterAddress,
        },
        multiProvider,
      );
    default:
      throw new Error(`Invalid TxSubmitterType.`);
  }
}

export type SubmitTransactionOptions = {
  selfRelay?: boolean;
  context: WriteCommandContext;
  strategyUrl?: string;
  receiptsDir: string;
};

/**
 * Submits a set of transactions to the specified chain and outputs transaction receipts
 */
export async function submitTransactions(
  params: SubmitTransactionOptions,
  chainTransactions: Record<string, AnnotatedEV5Transaction[]>,
): Promise<void> {
  const chains = Object.keys(chainTransactions);
  const chainIdToName = Object.fromEntries(
    chains.map((chain) => [
      chain,
      params.context.multiProvider.getChainName(chain),
    ]),
  );

  await promiseObjAll(
    objMap(chainTransactions, async (chainId, transactions) => {
      await retryAsync(
        async () => {
          const chain = chainIdToName[chainId];
          const { submitter, config } =
            await getTxSubmitter<ProtocolType.Ethereum>({
              chain,
              context: params.context,
              strategyUrl: params.strategyUrl,
            });
          const transactionReceipts = await submitter.submit(...transactions);

          if (transactionReceipts) {
            const receiptPath = `${params.receiptsDir}/${chain}-${
              submitter.txSubmitterType
            }-${Date.now()}-receipts.json`;
            writeYamlOrJson(receiptPath, transactionReceipts);
            logGreen(
              `Transactions receipts successfully written to ${receiptPath}`,
            );
          }

          const canRelay = canSelfRelay(
            params.selfRelay ?? false,
            config,
            transactionReceipts,
          );
          if (canRelay.relay) {
            await runSelfRelay({
              txReceipt: canRelay.txReceipt,
              multiProvider: params.context.multiProvider,
              registry: params.context.registry,
              // successMessage: WarpSendLogs.SUCCESS,
            });
          }
        },
        5, // attempts
        100, // baseRetryMs
      );
    }),
  );
}

/**
 * Retrieves a chain submission strategy from the provided filepath.
 * @param submissionStrategyFilepath a filepath to the submission strategy file
 * @returns a formatted submission strategy
 */
export function readChainSubmissionStrategy(
  submissionStrategyFilepath: string,
): ChainSubmissionStrategy {
  const submissionStrategyFileContent = readYamlOrJson(
    submissionStrategyFilepath.trim(),
  );
  return ChainSubmissionStrategySchema.parse(submissionStrategyFileContent);
}

/**
 * Helper function to get warp apply specific submitter.
 *
 * @returns the warp apply submitter
 */
async function getTxSubmitter<T extends ProtocolType>({
  chain,
  context,
  strategyUrl,
}: {
  chain: ChainName;
  context: WriteCommandContext;
  strategyUrl?: string;
}): Promise<{
  submitter: TxSubmitterBuilder<T>;
  config: SubmissionStrategy;
}> {
  const { multiProvider, registry } = context;

  const submissionStrategy: SubmissionStrategy = strategyUrl
    ? readChainSubmissionStrategy(strategyUrl)[chain]
    : {
        submitter: {
          chain,
          type: TxSubmitterType.JSON_RPC,
        },
      };

  return {
    submitter: await getSubmitterBuilder<T>({
      submissionStrategy: SubmissionStrategySchema.parse(submissionStrategy),
      multiProvider,
      registry,
    }),
    config: submissionStrategy,
  };
}
