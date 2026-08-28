import { type PopulatedTransaction, type providers } from 'ethers';
import { type Logger } from 'pino';

import {
  type ChainMap,
  type ChainMetadata,
  type ChainName,
  type EthJsonRpcBlockParameterTag,
  EvmMovableCollateralAdapter,
  type InterchainGasQuote,
  type MultiProvider,
  type Token,
  type WarpCore,
} from '@hyperlane-xyz/sdk';
import { eqAddress, isNullish, mapAllSettled } from '@hyperlane-xyz/utils';

import {
  Erc20ApprovalMode,
  type Erc20ApprovalOptions,
  approveErc20IfNeeded,
  revokeErc20Approval,
  revokeErc20ApprovalIfNeeded,
} from '../bridges/erc20Approve.js';
import { createStatusAdapters } from '../bridges/status/index.js';
import { TokenBridgeStatusAdapterType } from '../config/types.js';
import type {
  IMovableCollateralRebalancer,
  MovableCollateralExecutionResult,
  PreparedTransaction,
  RebalancerType,
} from '../interfaces/IRebalancer.js';
import { MovableCollateralRoute } from '../interfaces/IStrategy.js';
import type {
  MCRStatusRef,
  StatusAdaptersByKind,
} from '../interfaces/ITokenBridgeStatusAdapter.js';
import { type Metrics } from '../metrics/Metrics.js';
import type { IActionTracker } from '../tracking/IActionTracker.js';
import type { RebalanceIntent } from '../tracking/types.js';
import {
  denormalizeToLocal,
  normalizeToCanonical,
} from '../utils/balanceUtils.js';

// Internal types with intentId for tracking
type InternalExecutionResult = MovableCollateralExecutionResult & {
  intentId: string;
  actionId?: string;
  canonicalAmount?: bigint;
  localAmount?: bigint;
};

type InternalRoute = MovableCollateralRoute & { intentId: string };
type CollateralFeeApproval = NonNullable<
  PreparedTransaction['collateralFeeApproval']
>;
type CollateralFeeApprovalGroup = CollateralFeeApproval & {
  origin: ChainName;
  transactions: PreparedTransaction[];
};

export class Rebalancer implements IMovableCollateralRebalancer {
  public readonly rebalancerType: RebalancerType = 'movableCollateral';
  private readonly logger: Logger;
  private readonly statusAdaptersByKind: StatusAdaptersByKind;

  constructor(
    private readonly warpCore: WarpCore,
    private readonly chainMetadata: ChainMap<ChainMetadata>,
    private readonly tokensByChainName: ChainMap<Token>,
    private readonly multiProvider: MultiProvider,
    private readonly actionTracker: IActionTracker,
    logger: Logger,
    private readonly metrics?: Metrics,
    private readonly approvalOptions: Pick<
      Erc20ApprovalOptions,
      'contractFactory'
    > = {},
    statusAdaptersByKind?: StatusAdaptersByKind,
  ) {
    this.logger = logger.child({ class: Rebalancer.name });
    this.statusAdaptersByKind =
      statusAdaptersByKind ?? createStatusAdapters(this.logger);
  }

  async rebalance(
    routes: MovableCollateralRoute[],
  ): Promise<MovableCollateralExecutionResult[]> {
    if (routes.length === 0) {
      this.logger.info('No routes to execute, exiting');
      return [];
    }

    this.logger.info({ numberOfRoutes: routes.length }, 'Rebalance initiated');

    const invalidRoutes = routes.filter((r) => !r.bridge);
    if (invalidRoutes.length > 0) {
      this.logger.error(
        { count: invalidRoutes.length },
        'Routes missing required bridge address',
      );
      return routes.map((r) => ({
        route: r,
        success: false,
        error: r.bridge ? undefined : 'Missing required bridge address',
        messageId: '', // Required by MovableCollateralExecutionResult, empty for validation failures
      }));
    }

    const intents = await this.createIntents(routes);

    const internalRoutes: InternalRoute[] = routes.map((route, idx) => ({
      ...route,
      bridge: route.bridge!,
      intentId: intents[idx].id,
    }));

    const { preparedTransactions, preparationFailureResults } =
      await this.prepareTransactions(internalRoutes);

    let executionResults: InternalExecutionResult[] = [];

    if (preparedTransactions.length > 0) {
      executionResults = await this.executeTransactions(preparedTransactions);
    }

    const allInternalResults = [
      ...preparationFailureResults,
      ...executionResults,
    ];

    await this.processResults(allInternalResults);

    const successfulResults = allInternalResults.filter((r) => r.success);
    if (this.metrics && successfulResults.length > 0) {
      for (const result of successfulResults) {
        const token = this.tokensByChainName[result.route.origin];
        if (token) {
          this.metrics.recordRebalanceAmount(
            result.route,
            token.amount(
              result.localAmount ??
                denormalizeToLocal(result.route.amount, token),
            ),
          );
        }
      }
    }

    const failures = allInternalResults.filter((r) => !r.success);
    if (failures.length > 0) {
      this.logger.error(
        { failureCount: failures.length, totalRoutes: routes.length },
        'Some rebalance operations failed.',
      );
    } else {
      this.logger.info('Rebalance successful');
    }

    return this.toPublicResults(allInternalResults);
  }

  private async createIntents(
    routes: MovableCollateralRoute[],
  ): Promise<RebalanceIntent[]> {
    return Promise.all(
      routes.map((route) =>
        this.actionTracker.createRebalanceIntent({
          origin: this.multiProvider.getDomainId(route.origin),
          destination: this.multiProvider.getDomainId(route.destination),
          amount: route.amount,
          bridge: route.bridge,
          executionMethod: 'movable_collateral',
        }),
      ),
    );
  }

  private async processResults(
    results: InternalExecutionResult[],
  ): Promise<void> {
    for (const result of results) {
      const intentId = result.intentId;

      if (result.success && result.externalExecutionRef && result.actionId) {
        this.logger.info(
          {
            intentId,
            actionId: result.actionId,
            messageId: result.messageId,
            statusAdapter: result.externalExecutionRef.kind,
            txHash: result.txHash,
            origin: result.route.origin,
            destination: result.route.destination,
          },
          'Rebalance action execution identity recorded',
        );
      } else if (result.actionId) {
        this.logger.warn(
          {
            intentId,
            actionId: result.actionId,
            error: result.error,
          },
          'Source execution may have started; action remains suppressed for this process lifetime',
        );
      } else {
        await this.actionTracker.failRebalanceIntent(intentId);

        this.logger.warn(
          {
            intentId,
            success: result.success,
            error: result.error,
            origin: result.route.origin,
            destination: result.route.destination,
          },
          'Rebalance intent marked as failed',
        );
      }
    }
  }

  private toPublicResults(
    internalResults: InternalExecutionResult[],
  ): MovableCollateralExecutionResult[] {
    return internalResults.map((internal) => ({
      route: internal.route,
      success: internal.success,
      error: internal.error,
      messageId: internal.messageId || '', // Ensure messageId is always a string
      txHash: internal.txHash,
      externalExecutionRef: internal.externalExecutionRef,
    }));
  }

  private async prepareTransactions(routes: InternalRoute[]): Promise<{
    preparedTransactions: PreparedTransaction[];
    preparationFailureResults: InternalExecutionResult[];
  }> {
    this.logger.info(
      { numRoutes: routes.length },
      'Preparing all rebalance transactions.',
    );
    const { fulfilled, rejected } = await mapAllSettled(
      routes,
      (route) => this.prepareTransaction(route),
      (_, i) => i,
    );

    // Filter out null results (validation failures logged internally)
    const preparedTransactions = Array.from(fulfilled.values()).filter(
      (tx): tx is PreparedTransaction => !isNullish(tx),
    );

    // Create failure results for tracking
    const preparationFailureResults: InternalExecutionResult[] = [];
    for (const [i, error] of rejected) {
      preparationFailureResults.push({
        route: routes[i],
        intentId: routes[i].intentId,
        success: false,
        error: String(error),
        messageId: '', // Required by MovableCollateralExecutionResult, empty for failures
      });
    }
    // Also track null results (validation failures)
    Array.from(fulfilled.entries()).forEach(([i, tx]) => {
      if (isNullish(tx)) {
        preparationFailureResults.push({
          route: routes[i],
          intentId: routes[i].intentId,
          success: false,
          error: 'Preparation returned null',
          messageId: '', // Required by MovableCollateralExecutionResult, empty for failures
        });
      }
    });

    return { preparedTransactions, preparationFailureResults };
  }

  private async prepareTransaction(
    route: InternalRoute,
  ): Promise<PreparedTransaction | null> {
    const { origin, destination, amount } = route;

    this.logger.info(
      {
        origin,
        destination,
        amount,
      },
      'Preparing transaction for route',
    );

    // 1. Adapter and permissions validation
    if (!(await this.validateRoute(route))) {
      // Errors logged in validateRoute
      return null;
    }

    const originToken = this.tokensByChainName[origin];
    const destinationToken = this.tokensByChainName[destination];
    const destinationChainMeta = this.chainMetadata[destination];
    const localAmount = denormalizeToLocal(amount, originToken);

    const originTokenAmount = originToken.amount(localAmount);
    const decimalFormattedAmount =
      originTokenAmount.getDecimalFormattedAmount();
    const originHypAdapter = originToken.getHypAdapter(
      this.warpCore.multiProvider,
    ) as EvmMovableCollateralAdapter;

    const { bridge } = route;

    // 2. Get quotes
    let quotes: InterchainGasQuote[];
    try {
      quotes = await originHypAdapter.getRebalanceQuotes(
        bridge,
        destinationChainMeta.domainId,
        destinationToken.addressOrDenom,
        localAmount,
      );
    } catch (error) {
      this.logger.error(
        {
          origin,
          destination,
          amount: decimalFormattedAmount,
          tokenName: originToken.name,
          error,
        },
        'Failed to get quotes for route.',
      );
      return null;
    }

    const collateralFeeApproval =
      await this.getCollateralFeeApprovalRequirement(
        originHypAdapter,
        originToken.addressOrDenom,
        quotes,
        localAmount,
      );

    // 3. Populate transaction
    let populatedTx: PopulatedTransaction;
    try {
      populatedTx = await originHypAdapter.populateRebalanceTx(
        destinationChainMeta.domainId,
        localAmount,
        bridge,
        quotes,
      );
    } catch (error) {
      this.logger.error(
        {
          origin,
          destination,
          amount: decimalFormattedAmount,
          tokenName: originToken.name,
          error,
        },
        'Failed to populate transaction for route.',
      );
      return null;
    }

    return {
      populatedTx,
      route,
      originTokenAmount,
      collateralFeeApproval,
    };
  }

  private async getCollateralFeeApprovalRequirement(
    originHypAdapter: EvmMovableCollateralAdapter,
    router: string,
    quotes: InterchainGasQuote[],
    localAmount: bigint,
  ): Promise<PreparedTransaction['collateralFeeApproval']> {
    if (quotes.every((quote) => !quote.igpQuote.addressOrDenom)) {
      return undefined;
    }

    const collateralToken = await originHypAdapter.getWrappedTokenAddress();
    const quotedCollateral = quotes.reduce(
      (total, quote) =>
        quote.igpQuote.addressOrDenom &&
        eqAddress(quote.igpQuote.addressOrDenom, collateralToken)
          ? total + quote.igpQuote.amount
          : total,
      0n,
    );

    if (quotedCollateral <= localAmount) return undefined;

    return {
      token: collateralToken,
      spender: router,
      amount: quotedCollateral - localAmount,
    };
  }

  private async validateRoute(route: InternalRoute): Promise<boolean> {
    const { origin, destination, amount } = route;
    const originToken = this.tokensByChainName[origin];
    const destinationToken = this.tokensByChainName[destination];
    const destinationDomain = this.chainMetadata[destination];

    if (!originToken) {
      this.logger.error(
        { origin, destination, amount },
        'Route validation failed: origin token not found.',
      );
      return false;
    }

    const localAmount = denormalizeToLocal(amount, originToken);
    const originTokenAmount = originToken.amount(localAmount);
    const decimalFormattedAmount =
      originTokenAmount.getDecimalFormattedAmount();

    if (!destinationToken) {
      this.logger.error(
        { origin, destination, amount: decimalFormattedAmount },
        'Route validation failed: destination token not found.',
      );
      return false;
    }

    if (!destinationDomain) {
      this.logger.error(
        { origin, destination, amount: decimalFormattedAmount },
        'Route validation failed: destination domain metadata not found.',
      );
      return false;
    }

    const originHypAdapter = originToken.getHypAdapter(
      this.warpCore.multiProvider,
    );
    if (!(originHypAdapter instanceof EvmMovableCollateralAdapter)) {
      this.logger.error(
        {
          origin,
          destination,
          amount: decimalFormattedAmount,
          tokenName: originToken.name,
        },
        'Route validation failed: Origin TokenAdapter is not an EvmHypCollateralAdapter.',
      );
      return false;
    }

    const signer = this.multiProvider.getSigner(origin);
    const signerAddress = await signer.getAddress();
    if (!(await originHypAdapter.isRebalancer(signerAddress))) {
      this.logger.error(
        {
          origin,
          destination,
          amount: decimalFormattedAmount,
          tokenName: originToken.name,
          tokenAddress: originToken.addressOrDenom,
          signerAddress,
        },
        'Route validation failed: Signer is not a rebalancer.',
      );
      return false;
    }

    const allowedDestination = await originHypAdapter.getAllowedDestination(
      destinationDomain.domainId,
    );
    if (!eqAddress(allowedDestination, destinationToken.addressOrDenom)) {
      this.logger.error(
        {
          origin,
          destination,
          amount: decimalFormattedAmount,
          tokenName: originToken.name,
          tokenAddress: originToken.addressOrDenom,
          destinationTokenAddress: destinationToken.addressOrDenom,
          allowedDestinationTokenAddress: allowedDestination,
        },
        'Route validation failed: Destination is not allowed.',
      );
      return false;
    }

    const { bridge } = route;

    if (
      !(await originHypAdapter.isBridgeAllowed(
        destinationDomain.domainId,
        bridge,
      ))
    ) {
      this.logger.error(
        {
          origin,
          destination,
          amount: decimalFormattedAmount,
          tokenName: originToken.name,
          tokenAddress: originToken.addressOrDenom,
          bridgeAddress: bridge,
        },
        'Route validation failed: Bridge is not allowed.',
      );
      return false;
    }

    return true;
  }

  private async executeTransactions(
    transactions: PreparedTransaction[],
  ): Promise<InternalExecutionResult[]> {
    const approvalGroups = this.groupCollateralFeeApprovals(transactions);
    const { failures: approvalFailures, failedGroups } =
      await this.approveCollateralFeeGroups(approvalGroups);
    const approvedTransactions = transactions.filter(
      (transaction) => !approvalFailures.has(transaction),
    );
    const approvalFailureResults: InternalExecutionResult[] = Array.from(
      approvalFailures.entries(),
      ([transaction, error]) => ({
        route: transaction.route,
        intentId: transaction.route.intentId,
        success: false,
        error: `Collateral fee approval failed: ${String(error)}`,
        messageId: '',
      }),
    );

    try {
      const executionResults =
        approvedTransactions.length === 0
          ? []
          : await this.executeApprovedTransactions(approvedTransactions);
      return [...approvalFailureResults, ...executionResults];
    } finally {
      await this.cleanupCollateralFeeGroups(approvalGroups, failedGroups);
    }
  }

  private async executeApprovedTransactions(
    transactions: PreparedTransaction[],
  ): Promise<InternalExecutionResult[]> {
    this.logger.info(
      { numTransactions: transactions.length },
      'Estimating gas for all prepared transactions.',
    );

    const results: InternalExecutionResult[] = [];

    // The exact allowance deliberately makes a higher on-chain quote fail.
    // A later cycle will fetch a fresh quote; this cycle never widens it.
    const gasEstimateResults = await Promise.allSettled(
      transactions.map(async (transaction) => {
        await this.multiProvider.estimateGas(
          transaction.route.origin,
          transaction.populatedTx,
        );
        return transaction;
      }),
    );

    const validTransactions: PreparedTransaction[] = [];
    gasEstimateResults.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        validTransactions.push(result.value);
      } else {
        const failedTransaction = transactions[i];
        this.logger.error(
          {
            origin: failedTransaction.route.origin,
            destination: failedTransaction.route.destination,
            amount:
              failedTransaction.originTokenAmount.getDecimalFormattedAmount(),
            tokenName: failedTransaction.originTokenAmount.token.name,
            error: result.reason,
          },
          'Gas estimation failed for route.',
        );
        results.push({
          route: failedTransaction.route,
          intentId: failedTransaction.route.intentId,
          success: false,
          error: `Gas estimation failed: ${String(result.reason)}`,
          messageId: '',
        });
      }
    });

    if (validTransactions.length === 0) {
      this.logger.info('No transactions to execute after gas estimation.');
      return results;
    }

    const txsByOrigin = new Map<ChainName, PreparedTransaction[]>();
    for (const tx of validTransactions) {
      const origin = tx.route.origin;
      const originTransactions = txsByOrigin.get(origin);
      if (originTransactions) originTransactions.push(tx);
      else txsByOrigin.set(origin, [tx]);
    }

    this.logger.info(
      {
        numChains: txsByOrigin.size,
        numTransactions: validTransactions.length,
      },
      'Sending transactions (parallel across chains, sequential within chain).',
    );

    const chainSendResults = await Promise.allSettled(
      Array.from(txsByOrigin.entries()).map(([origin, txs]) =>
        this.sendTransactionsForChain(origin, txs),
      ),
    );
    const successfulSends: Array<{
      transaction: PreparedTransaction;
      receipt: providers.TransactionReceipt;
      actionId: string;
    }> = [];

    chainSendResults.forEach((chainResult) => {
      if (chainResult.status === 'fulfilled') {
        for (const txResult of chainResult.value) {
          if ('receipt' in txResult) {
            successfulSends.push(txResult);
          } else {
            results.push({
              route: txResult.transaction.route,
              intentId: txResult.transaction.route.intentId,
              actionId: txResult.actionId,
              success: false,
              error: `Transaction send failed: ${txResult.error}`,
              messageId: '',
            });
            this.metrics?.recordActionAttempt(
              txResult.transaction.route,
              false,
            );
          }
        }
      } else {
        this.logger.error(
          { error: chainResult.reason },
          'Unexpected error during chain transaction sending.',
        );
      }
    });

    // 6. Build results from confirmed receipts
    for (const { transaction, receipt, actionId } of successfulSends) {
      const result = await this.buildResult(transaction, receipt, actionId);
      results.push(result);
      this.metrics?.recordActionAttempt(result.route, result.success);
    }

    return results;
  }

  private groupCollateralFeeApprovals(
    transactions: PreparedTransaction[],
  ): Map<ChainName, CollateralFeeApprovalGroup[]> {
    const groupsByOrigin = new Map<
      ChainName,
      Map<string, CollateralFeeApprovalGroup>
    >();

    for (const transaction of transactions) {
      const approval = transaction.collateralFeeApproval;
      if (!approval) continue;

      const origin = transaction.route.origin;
      let originGroups = groupsByOrigin.get(origin);
      if (!originGroups) {
        originGroups = new Map();
        groupsByOrigin.set(origin, originGroups);
      }

      const key = `${approval.token.toLowerCase()}:${approval.spender.toLowerCase()}`;
      const group = originGroups.get(key);
      if (group) {
        group.amount += approval.amount;
        group.transactions.push(transaction);
      } else {
        originGroups.set(key, {
          ...approval,
          origin,
          transactions: [transaction],
        });
      }
    }

    return new Map(
      Array.from(groupsByOrigin, ([origin, groups]) => [
        origin,
        Array.from(groups.values()),
      ]),
    );
  }

  private async approveCollateralFeeGroups(
    groupsByOrigin: Map<ChainName, CollateralFeeApprovalGroup[]>,
  ): Promise<{
    failures: Map<PreparedTransaction, unknown>;
    failedGroups: Set<CollateralFeeApprovalGroup>;
  }> {
    const failures = new Map<PreparedTransaction, unknown>();
    const failedGroups = new Set<CollateralFeeApprovalGroup>();

    await Promise.all(
      Array.from(groupsByOrigin, async ([origin, groups]) => {
        // Sequential per origin avoids approval nonce contention.
        for (const group of groups) {
          try {
            await approveErc20IfNeeded(
              this.multiProvider.getSigner(origin),
              group.token,
              group.spender,
              group.amount,
              this.logger,
              {
                ...this.approvalOptions,
                mode: Erc20ApprovalMode.Exact,
              },
            );
          } catch (error) {
            failedGroups.add(group);
            this.logger.error(
              {
                origin,
                token: group.token,
                spender: group.spender,
                amount: group.amount.toString(),
                error,
              },
              'Collateral fee approval failed',
            );
            for (const transaction of group.transactions) {
              failures.set(transaction, error);
            }
          }
        }
      }),
    );

    return { failures, failedGroups };
  }

  private async cleanupCollateralFeeGroups(
    groupsByOrigin: Map<ChainName, CollateralFeeApprovalGroup[]>,
    failedGroups: Set<CollateralFeeApprovalGroup>,
  ): Promise<void> {
    await Promise.all(
      Array.from(groupsByOrigin, async ([origin, groups]) => {
        // Sequential per origin avoids cleanup nonce contention.
        for (const group of groups) {
          try {
            const signer = this.multiProvider.getSigner(origin);
            if (failedGroups.has(group)) {
              // An approval receipt timeout is ambiguous. Queue a zero after
              // the possibly pending approval instead of trusting a stale read.
              await revokeErc20Approval(
                signer,
                group.token,
                group.spender,
                this.logger,
                this.approvalOptions,
              );
            } else {
              await revokeErc20ApprovalIfNeeded(
                signer,
                group.token,
                group.spender,
                this.logger,
                this.approvalOptions,
              );
            }
          } catch (error) {
            // Execution results remain authoritative even if best-effort
            // residue cleanup fails after a send or approval failure.
            this.logger.error(
              {
                origin,
                token: group.token,
                spender: group.spender,
                error,
              },
              'Failed to clean up collateral fee approval residue',
            );
          }
        }
      }),
    );
  }

  // === Parallel Transaction Sending Methods ===

  /**
   * Send all transactions for a single origin chain sequentially.
   * Sequential sending is required to avoid nonce contention when using the same signing key.
   */
  private async sendTransactionsForChain(
    origin: ChainName,
    transactions: PreparedTransaction[],
  ): Promise<
    Array<
      | {
          transaction: PreparedTransaction;
          receipt: providers.TransactionReceipt;
          actionId: string;
        }
      | {
          transaction: PreparedTransaction;
          error: string;
          actionId?: string;
        }
    >
  > {
    const results: Array<
      | {
          transaction: PreparedTransaction;
          receipt: providers.TransactionReceipt;
          actionId: string;
        }
      | {
          transaction: PreparedTransaction;
          error: string;
          actionId?: string;
        }
    > = [];

    // Send sequentially to avoid nonce contention
    for (const transaction of transactions) {
      let actionId: string | undefined;
      try {
        const decimalFormattedAmount =
          transaction.originTokenAmount.getDecimalFormattedAmount();
        const tokenName = transaction.originTokenAmount.token.name;

        const reorgPeriod = this.getReorgPeriod(origin);

        const action = await this.actionTracker.createRebalanceAction({
          intentId: transaction.route.intentId,
          origin: this.multiProvider.getDomainId(origin),
          destination: this.multiProvider.getDomainId(
            transaction.route.destination,
          ),
          amount: normalizeToCanonical(
            transaction.originTokenAmount.amount,
            transaction.originTokenAmount.token,
          ),
          type: 'rebalance_message',
        });
        actionId = action.id;

        this.logger.info(
          {
            origin,
            destination: transaction.route.destination,
            amount: decimalFormattedAmount,
            tokenName,
            reorgPeriod,
          },
          'Sending rebalance transaction and waiting for reorgPeriod confirmations.',
        );

        const receipt = await this.multiProvider.sendTransaction(
          origin,
          transaction.populatedTx,
          {
            waitConfirmations: reorgPeriod as
              | number
              | EthJsonRpcBlockParameterTag,
          },
        );

        await this.actionTracker.updateRebalanceActionExecution(actionId, {
          txHash: receipt.transactionHash,
        });

        this.logger.info(
          {
            origin,
            destination: transaction.route.destination,
            amount: decimalFormattedAmount,
            tokenName,
            txHash: receipt.transactionHash,
          },
          'Rebalance transaction confirmed at reorgPeriod depth.',
        );

        results.push({ transaction, receipt, actionId });
      } catch (error) {
        this.logger.error(
          {
            origin,
            destination: transaction.route.destination,
            amount: transaction.originTokenAmount.getDecimalFormattedAmount(),
            tokenName: transaction.originTokenAmount.token.name,
            error,
          },
          'Transaction send failed for route.',
        );
        results.push({ transaction, error: String(error), actionId });
      }
    }

    return results;
  }

  /**
   * Build the execution result from a confirmed transaction receipt.
   * Receipt is already confirmed at reorgPeriod depth from sendTransaction.
   */
  private async buildResult(
    transaction: PreparedTransaction,
    receipt: providers.TransactionReceipt,
    actionId: string,
  ): Promise<InternalExecutionResult> {
    const { origin, destination } = transaction.route;
    const statusAdapterKind =
      transaction.route.statusAdapter?.kind ??
      TokenBridgeStatusAdapterType.HyperlaneMessage;
    const statusAdapter = this.statusAdaptersByKind.get(statusAdapterKind);

    if (!statusAdapter) {
      this.logger.error(
        { origin, destination, statusAdapterKind },
        'No movable collateral status adapter registered',
      );
      return {
        route: transaction.route,
        intentId: transaction.route.intentId,
        actionId,
        success: false,
        error: `No status adapter registered for ${statusAdapterKind}`,
        messageId: '', // Required by MovableCollateralExecutionResult, empty for failures
        txHash: receipt.transactionHash,
      };
    }

    let externalExecutionRef: MCRStatusRef | null;
    try {
      externalExecutionRef = await statusAdapter.initFromReceipt({
        origin,
        destination,
        originDomain: this.multiProvider.getDomainId(origin),
        destinationDomain: this.multiProvider.getDomainId(destination),
        bridge: transaction.route.bridge,
        ...(transaction.route.statusAdapter?.kind ===
        TokenBridgeStatusAdapterType.LayerZeroScan
          ? {
              sourceEid: transaction.route.statusAdapter.sourceEid,
              destinationEid: transaction.route.statusAdapter.destinationEid,
              sourceOft: transaction.route.statusAdapter.sourceOft,
              destinationOft: transaction.route.statusAdapter.destinationOft,
              destinationRecipient:
                this.tokensByChainName[destination].addressOrDenom,
              sourceTokenDecimals: this.tokensByChainName[origin].decimals,
              destinationTokenDecimals:
                this.tokensByChainName[destination].decimals,
              minimumDestinationAmount: denormalizeToLocal(
                normalizeToCanonical(
                  transaction.originTokenAmount.amount,
                  transaction.originTokenAmount.token,
                ),
                this.tokensByChainName[destination],
              ),
            }
          : {}),
        receipt,
      });
    } catch (error) {
      this.logger.error(
        { origin, destination, statusAdapterKind, error },
        'Failed to initialize movable collateral settlement tracking',
      );
      externalExecutionRef = null;
    }

    if (!externalExecutionRef) {
      const error =
        statusAdapterKind === TokenBridgeStatusAdapterType.HyperlaneMessage
          ? 'Transaction confirmed but no Dispatch event found'
          : `Transaction confirmed but ${statusAdapterKind} settlement tracking could not be initialized`;
      return {
        route: transaction.route,
        intentId: transaction.route.intentId,
        actionId,
        success: false,
        error,
        messageId: '',
        txHash: receipt.transactionHash,
      };
    }

    const messageId =
      externalExecutionRef.kind ===
        TokenBridgeStatusAdapterType.HyperlaneMessage &&
      typeof externalExecutionRef.data.messageId === 'string'
        ? externalExecutionRef.data.messageId
        : '';

    await this.actionTracker.updateRebalanceActionExecution(actionId, {
      messageId: messageId || undefined,
      txHash: receipt.transactionHash,
      externalExecutionRef,
    });

    return {
      route: transaction.route,
      intentId: transaction.route.intentId,
      actionId,
      success: true,
      messageId,
      txHash: receipt.transactionHash,
      externalExecutionRef,
      canonicalAmount: normalizeToCanonical(
        transaction.originTokenAmount.amount,
        transaction.originTokenAmount.token,
      ),
      localAmount: transaction.originTokenAmount.amount,
    };
  }

  private getReorgPeriod(chainName: string): number | string {
    const metadata = this.multiProvider.getChainMetadata(chainName);
    return metadata.blocks?.reorgPeriod ?? 32;
  }
}
