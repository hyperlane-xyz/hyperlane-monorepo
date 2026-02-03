import { ethers, providers } from 'ethers';
import { Logger } from 'pino';

import {
  ChainMap,
  ChainName,
  DispatchedMessage,
  EvmHookReader,
  EvmIsmReader,
  GasPaymentEnforcement,
  GasPaymentEnforcementPolicyType,
  GasPolicyStatus,
  HookConfig,
  HookType,
  HyperlaneCore,
  IgpHookConfig,
  IsmConfig,
  MultiProvider,
  getGasPaymentForMessage,
  messageMatchesMatchingList,
  parseGasPaymentsFromReceipt,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  WithAddress,
  assert,
  deepFind,
  messageId,
  objMap,
  objMerge,
  parseMessage,
  promiseObjAll,
  sleep,
} from '@hyperlane-xyz/utils';

import { BaseMetadataBuilder } from '../metadata/builder.js';

import { RelayerCache } from './cache.js';
import { RelayerObserver } from './events.js';
import { messageMatchesWhitelist } from './whitelist.js';

type DerivedHookConfig = WithAddress<Exclude<HookConfig, Address>>;
type DerivedIsmConfig = WithAddress<Exclude<IsmConfig, Address>>;

export class GasPaymentEnforcementError extends Error {
  constructor(
    public readonly messageId: string,
    public readonly status: GasPolicyStatus,
  ) {
    const reason =
      status === GasPolicyStatus.NoPaymentFound
        ? 'no gas payment found'
        : 'gas payment below policy minimum';
    super(`Message ${messageId} gas payment enforcement failed: ${reason}`);
    this.name = 'GasPaymentEnforcementError';
  }
}

export class HyperlaneRelayer {
  protected multiProvider: MultiProvider;
  protected metadataBuilder: BaseMetadataBuilder;
  protected readonly core: HyperlaneCore;
  protected readonly retryTimeout: number;

  protected readonly whitelist: ChainMap<Set<Address>> | undefined;
  protected readonly gasPaymentEnforcement: GasPaymentEnforcement[];
  protected readonly observer: RelayerObserver;

  public backlog: RelayerCache['backlog'];
  public cache: RelayerCache | undefined;

  protected stopRelayingHandler: ((chains?: ChainName[]) => void) | undefined;

  public readonly logger: Logger;

  constructor({
    core,
    caching = true,
    retryTimeout = 1000,
    whitelist = undefined,
    gasPaymentEnforcement = [],
    observer = {},
  }: {
    core: HyperlaneCore;
    caching?: boolean;
    retryTimeout?: number;
    whitelist?: ChainMap<Address[]>;
    gasPaymentEnforcement?: GasPaymentEnforcement[];
    observer?: RelayerObserver;
  }) {
    this.core = core;
    this.retryTimeout = retryTimeout;
    this.logger = core.logger.child({ module: 'Relayer' });
    this.metadataBuilder = new BaseMetadataBuilder(core);
    this.multiProvider = core.multiProvider;
    this.observer = observer;
    this.gasPaymentEnforcement = gasPaymentEnforcement;
    if (whitelist) {
      this.whitelist = objMap(
        whitelist,
        (_chain, addresses) => new Set(addresses),
      );
    }

    this.backlog = [];
    if (caching) {
      this.cache = {
        hook: {},
        ism: {},
        backlog: [],
      };
    }
  }

  async getHookConfig(
    chain: ChainName,
    hook: Address,
    messageContext?: DispatchedMessage,
  ): Promise<DerivedHookConfig> {
    let config: DerivedHookConfig | undefined;
    if (this.cache?.hook[chain]?.[hook]) {
      config = this.cache.hook[chain][hook] as DerivedHookConfig | undefined;
    } else {
      const evmHookReader = new EvmHookReader(
        this.multiProvider,
        chain,
        undefined,
        messageContext,
      );
      config = await evmHookReader.deriveHookConfig(hook);
    }

    if (!config) {
      throw new Error(`Hook config not found for ${hook}`);
    }
    if (this.cache) {
      this.cache.hook[chain] ??= {};
      this.cache.hook[chain][hook] = config;
    }

    return config;
  }

  async getIsmConfig(
    chain: ChainName,
    ism: Address,
    messageContext?: DispatchedMessage,
  ): Promise<DerivedIsmConfig> {
    let config: DerivedIsmConfig | undefined;
    if (this.cache?.ism[chain]?.[ism]) {
      config = this.cache.ism[chain][ism] as DerivedIsmConfig | undefined;
    } else {
      const evmIsmReader = new EvmIsmReader(
        this.multiProvider,
        chain,
        undefined,
        messageContext,
      );
      config = await evmIsmReader.deriveIsmConfig(ism);
    }

    if (!config) {
      throw new Error(`ISM config not found for ${ism}`);
    }

    if (this.cache) {
      this.cache.ism[chain] ??= {};
      this.cache.ism[chain][ism] = config;
    }

    return config;
  }

  async getSenderHookConfig(
    message: DispatchedMessage,
  ): Promise<DerivedHookConfig> {
    const originChain = this.core.getOrigin(message);
    const hook = await this.core.getSenderHookAddress(message);
    return this.getHookConfig(originChain, hook, message);
  }

  async getRecipientIsmConfig(
    message: DispatchedMessage,
  ): Promise<DerivedIsmConfig> {
    const destinationChain = this.core.getDestination(message);
    const ism = await this.core.getRecipientIsmAddress(message);
    return this.getIsmConfig(destinationChain, ism, message);
  }

  async relayAll(
    dispatchTx: providers.TransactionReceipt,
    messages = HyperlaneCore.getDispatchedMessages(dispatchTx),
  ): Promise<ChainMap<ethers.ContractReceipt[]>> {
    const destinationMap: ChainMap<DispatchedMessage[]> = {};
    messages.forEach((message) => {
      destinationMap[message.parsed.destination] ??= [];
      destinationMap[message.parsed.destination].push(message);
    });

    // parallelize relaying to different destinations
    return promiseObjAll(
      objMap(destinationMap, async (_destination, messages) => {
        const receipts: ethers.ContractReceipt[] = [];
        // serially relay messages to the same destination
        for (const message of messages) {
          try {
            const receipt = await this.relayMessage(
              dispatchTx,
              undefined,
              message,
            );
            receipts.push(receipt);
          } catch (e) {
            this.logger.error(`Failed to relay message ${message.id}, ${e}`);
          }
        }
        return receipts;
      }),
    );
  }

  async relayMessage(
    dispatchTx: providers.TransactionReceipt,
    messageIndex = 0,
    message = HyperlaneCore.getDispatchedMessages(dispatchTx)[messageIndex],
  ): Promise<ethers.ContractReceipt> {
    const originChain = this.core.getOrigin(message);
    const destinationChain = this.core.getDestination(message);

    if (this.whitelist) {
      // add human readable names for use in whitelist checks
      message.parsed = {
        originChain,
        destinationChain,
        ...message.parsed,
      };
      if (!messageMatchesWhitelist(this.whitelist, message.parsed)) {
        this.observer.onEvent?.({
          type: 'messageSkipped',
          message,
          originChain,
          destinationChain,
          messageId: message.id,
          reason: 'whitelist',
          dispatchTx,
        });
        throw new Error(`Message ${message.id} does not match whitelist`);
      }
    }

    this.logger.info(`Preparing to relay message ${message.id}`);

    const isDelivered = await this.core.isDelivered(message);
    if (isDelivered) {
      this.logger.info(`Message ${message.id} already delivered`);
      this.observer.onEvent?.({
        type: 'messageSkipped',
        message,
        originChain,
        destinationChain,
        messageId: message.id,
        reason: 'already_delivered',
        dispatchTx,
      });
      return this.core.getProcessedReceipt(message);
    }

    const startTime = Date.now();

    // Fetch configs - parallelizable because they're on different chains
    let ism: DerivedIsmConfig;
    let hook: DerivedHookConfig;
    try {
      [ism, hook] = await Promise.all([
        this.getRecipientIsmConfig(message),
        this.getSenderHookConfig(message),
      ]);
    } catch (error) {
      this.observer.onEvent?.({
        type: 'messageFailed',
        message,
        originChain,
        destinationChain,
        messageId: message.id,
        error: error as Error,
        dispatchTx,
      });
      throw error;
    }
    this.logger.debug({ ism, hook }, `Retrieved ISM and hook configs`);

    // Estimate gas before checking payment (needed for OnChainFeeQuoting)
    // Returns '0' if estimation fails (e.g., ZkSync chains without funded signer)
    this.logger.debug({ message }, `Simulating recipient message handling`);
    const gasEstimate = await this.core.estimateHandle(message);

    // Check gas payment enforcement (like whitelist - emits messageSkipped)
    if (this.gasPaymentEnforcement.length > 0) {
      const gasStatus = await this.checkGasPayment(
        message,
        dispatchTx,
        hook,
        gasEstimate,
      );
      if (gasStatus !== GasPolicyStatus.PolicyMet) {
        this.observer.onEvent?.({
          type: 'messageSkipped',
          message,
          originChain,
          destinationChain,
          messageId: message.id,
          reason: 'gas_payment',
          dispatchTx,
        });
        throw new GasPaymentEnforcementError(message.id, gasStatus);
      }
    }

    // Relay the message
    try {
      const metadata = await this.metadataBuilder.build({
        message,
        ism,
        hook,
        dispatchTx,
      });

      this.logger.info(`Relaying message ${message.id}`);

      const receipt = await this.core.deliver(message, metadata);
      const durationMs = Date.now() - startTime;
      this.observer.onEvent?.({
        type: 'messageRelayed',
        message,
        originChain,
        destinationChain,
        messageId: message.id,
        durationMs,
        dispatchTx,
      });
      return receipt;
    } catch (error) {
      this.observer.onEvent?.({
        type: 'messageFailed',
        message,
        originChain,
        destinationChain,
        messageId: message.id,
        error: error as Error,
        dispatchTx,
      });
      throw error;
    }
  }

  hydrate(cache: RelayerCache): void {
    assert(this.cache, 'Caching not enabled');
    this.cache = objMerge(this.cache, cache);
  }

  /**
   * Check if gas payment meets enforcement policy for a message.
   * @param message The dispatched message
   * @param dispatchTx The dispatch transaction receipt
   * @param hook Optional hook config (will derive internally if not provided)
   * @param gasEstimate Optional gas estimate for OnChainFeeQuoting policy (will estimate internally if not provided)
   * @returns GasPolicyStatus indicating whether the policy is met
   */
  public async checkGasPayment(
    message: DispatchedMessage,
    dispatchTx: providers.TransactionReceipt,
    hook?: DerivedHookConfig,
    gasEstimate?: string,
  ): Promise<GasPolicyStatus> {
    // Find the first matching policy
    const matchInfo = {
      id: message.id,
      origin: message.parsed.origin,
      destination: message.parsed.destination,
      sender: message.parsed.sender,
      recipient: message.parsed.recipient,
      body: message.parsed.body,
    };

    const policy = this.gasPaymentEnforcement.find((p) =>
      messageMatchesMatchingList(p.matchingList, matchInfo),
    );

    // No matching policy or no enforcement configured = allow
    if (!policy) {
      return GasPolicyStatus.PolicyMet;
    }

    // None policy = always allow
    if (
      policy.type === GasPaymentEnforcementPolicyType.None ||
      policy.type === undefined
    ) {
      return GasPolicyStatus.PolicyMet;
    }

    // Derive hook config if not provided
    const derivedHook = hook ?? (await this.getSenderHookConfig(message));

    // Find IGP address from hook config
    type IgpWithAddress = WithAddress<IgpHookConfig>;
    const igpConfig = deepFind<DerivedHookConfig, IgpWithAddress>(
      derivedHook,
      (v): v is IgpWithAddress =>
        typeof v === 'object' &&
        v !== null &&
        'type' in v &&
        v.type === HookType.INTERCHAIN_GAS_PAYMASTER &&
        'address' in v,
    );

    if (!igpConfig) {
      // If policy requires payment but no IGP exists, that's a config error
      return GasPolicyStatus.NoPaymentFound;
    }

    // Parse gas payments from dispatch tx
    const payments = parseGasPaymentsFromReceipt(dispatchTx, igpConfig.address);
    const payment = getGasPaymentForMessage(
      payments,
      message.id,
      message.parsed.destination,
    );

    if (!payment) {
      return GasPolicyStatus.NoPaymentFound;
    }

    // Evaluate policy
    if (policy.type === GasPaymentEnforcementPolicyType.Minimum) {
      const minPayment = BigInt(policy.payment ?? 0);
      if (payment.payment < minPayment) {
        return GasPolicyStatus.PolicyNotMet;
      }
      return GasPolicyStatus.PolicyMet;
    }

    if (policy.type === GasPaymentEnforcementPolicyType.OnChainFeeQuoting) {
      // Estimate gas if not provided
      const estimate = gasEstimate ?? (await this.core.estimateHandle(message));

      // If gas estimation failed (returns '0'), we can't verify the policy
      // This can happen on ZkSync chains that require a funded signer for estimation
      if (estimate === '0') {
        this.logger.warn(
          { messageId: message.id },
          `Gas estimation unavailable, cannot verify OnChainFeeQuoting policy`,
        );
        return GasPolicyStatus.PolicyNotMet;
      }

      // Check that gasAmount paid meets the required fraction of estimated gas
      // gasFraction = numerator/denominator (e.g. 1/2 = require 50% of estimate)
      // Type assertion needed because Zod union doesn't narrow correctly after transform
      const gasFraction = policy.gasFraction as unknown as {
        numerator: number;
        denominator: number;
      };
      const gasEstimateBigInt = BigInt(estimate);

      // Required gas = gasEstimate * numerator / denominator
      const requiredGas =
        (gasEstimateBigInt * BigInt(gasFraction.numerator)) /
        BigInt(gasFraction.denominator);

      if (payment.gasAmount < requiredGas) {
        this.logger.debug(
          {
            gasAmount: payment.gasAmount.toString(),
            requiredGas: requiredGas.toString(),
            gasEstimate: estimate,
          },
          `Gas payment insufficient for OnChainFeeQuoting policy`,
        );
        return GasPolicyStatus.PolicyNotMet;
      }
      return GasPolicyStatus.PolicyMet;
    }

    return GasPolicyStatus.PolicyMet;
  }

  // fill cache with default ISM and hook configs for quicker relaying (optional)
  async hydrateDefaults(): Promise<void> {
    assert(this.cache, 'Caching not enabled');

    const defaults = await this.core.getDefaults();
    await promiseObjAll(
      objMap(defaults, async (chain, { ism, hook }) => {
        this.logger.debug(
          `Hydrating ${chain} cache with default ISM and hook configs`,
        );
        await this.getHookConfig(chain, hook);
        await this.getIsmConfig(chain, ism);
      }),
    );
  }

  protected async flushBacklog(): Promise<void> {
    while (this.stopRelayingHandler) {
      this.observer.onEvent?.({
        type: 'backlog',
        size: this.backlog.length,
      });

      const backlogMsg = this.backlog.shift();

      if (!backlogMsg) {
        this.logger.trace('Backlog empty, waiting 1s');
        await sleep(1000);
        continue;
      }

      // linear backoff (attempts * retryTimeout)
      const backoffTime =
        backlogMsg.lastAttempt + backlogMsg.attempts * this.retryTimeout;
      if (Date.now() < backoffTime) {
        this.backlog.push(backlogMsg);
        continue;
      }

      const { message, dispatchTx, attempts } = backlogMsg;
      const id = messageId(message);
      const parsed = parseMessage(message);
      const dispatchMsg = { id, message, parsed };
      const originChain =
        this.multiProvider.tryGetChainName(parsed.origin) ??
        String(parsed.origin);
      const destinationChain =
        this.multiProvider.tryGetChainName(parsed.destination) ??
        String(parsed.destination);

      try {
        // TODO: handle batching
        const dispatchReceipt = await this.multiProvider
          .getProvider(parsed.origin)
          .getTransactionReceipt(dispatchTx);

        await this.relayMessage(dispatchReceipt, undefined, dispatchMsg);
      } catch {
        const newAttempts = attempts + 1;
        this.logger.error(
          `Failed to relay message ${id} (attempt #${newAttempts})`,
        );
        this.observer.onEvent?.({
          type: 'retry',
          message: dispatchMsg,
          originChain,
          destinationChain,
          messageId: id,
          attempt: newAttempts,
        });
        this.backlog.push({
          ...backlogMsg,
          attempts: newAttempts,
          lastAttempt: Date.now(),
        });
      }
    }
  }

  protected whitelistChains(): string[] | undefined {
    return this.whitelist ? Object.keys(this.whitelist) : undefined;
  }

  start(): void {
    assert(!this.stopRelayingHandler, 'Relayer already started');

    this.backlog = this.cache?.backlog ?? [];

    const { removeHandler } = this.core.onDispatch(async (message, event) => {
      if (
        this.whitelist &&
        !messageMatchesWhitelist(this.whitelist, message.parsed)
      ) {
        this.logger.debug(
          { message, whitelist: this.whitelist },
          `Skipping message ${message.id} not matching whitelist`,
        );
        return;
      }

      this.backlog.push({
        attempts: 0,
        lastAttempt: Date.now(),
        message: message.message,
        dispatchTx: event.transactionHash,
      });
    }, this.whitelistChains());

    this.stopRelayingHandler = removeHandler;

    void this.flushBacklog();
  }

  stop(): void {
    assert(this.stopRelayingHandler, 'Relayer not started');
    this.stopRelayingHandler(this.whitelistChains());
    this.stopRelayingHandler = undefined;

    if (this.cache) {
      this.cache.backlog = this.backlog;
    }
  }
}
