import { BigNumber, utils } from 'ethers';
import { Logger } from 'pino';

import { IAccessManager, IAccessManager__factory } from '@hyperlane-xyz/core';
import {
  Address,
  ProtocolType,
  assert,
  eqAddress,
  isNullish,
  normalizeAddressEvm,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { ChainMap } from '../../../../types.js';
import { MultiProvider } from '../../../MultiProvider.js';
import {
  AnnotatedEV5Transaction,
  ProtocolTypedReceipt,
} from '../../../ProviderType.js';
import { TxSubmitterInterface } from '../TxSubmitterInterface.js';
import { TxSubmitterType } from '../TxSubmitterTypes.js';
import type { SubmitterGetter } from '../types.js';

import { EvmAccessManagerSubmitterProps } from './types.js';

type EvmAccessManagerSubmitterConstructorConfig = Pick<
  EvmAccessManagerSubmitterProps,
  'chain' | 'accessManagerAddress' | 'caller'
>;

type AccessManagerCall = {
  to: Address;
  data: string;
  value?: BigNumber;
  selector: string;
  label: string;
};

const AccessManagerCallMode = {
  Execute: 'execute',
  Schedule: 'schedule',
  AlreadyScheduled: 'alreadyScheduled',
} as const;

type ScheduleResolution = {
  mode: typeof AccessManagerCallMode.Schedule;
  // Known only when the caller is configured
  delay?: number;
};

type AlreadyScheduledResolution = {
  mode: typeof AccessManagerCallMode.AlreadyScheduled;
  readyAt: number;
};

type AccessManagerCallResolution =
  | { mode: typeof AccessManagerCallMode.Execute }
  | ScheduleResolution
  | AlreadyScheduledResolution;

type ScheduledCall = {
  call: AccessManagerCall;
  resolution: ScheduleResolution | AlreadyScheduledResolution;
};

type EvmReceipt = ProtocolTypedReceipt<ProtocolType.Ethereum>['receipt'];

function toIsoTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

export class EV5AccessManagerSubmitter implements TxSubmitterInterface<ProtocolType.Ethereum> {
  public readonly txSubmitterType: TxSubmitterType =
    TxSubmitterType.ACCESS_MANAGER;

  protected readonly logger: Logger = rootLogger.child({
    module: 'access-manager-submitter',
  });

  // Callers split one logical batch across submit() calls (e.g. ownership
  // transfers last), so immediate calls must stay behind any earlier schedule
  private hasScheduledCalls = false;

  protected constructor(
    protected readonly config: EvmAccessManagerSubmitterConstructorConfig,
    protected readonly multiProvider: MultiProvider,
    protected readonly proposerSubmitter: TxSubmitterInterface<ProtocolType.Ethereum>,
    protected readonly accessManager: IAccessManager,
  ) {}

  static async fromConfig(
    config: EvmAccessManagerSubmitterProps,
    multiProvider: MultiProvider,
    coreAddressesByChain: ChainMap<Record<string, string>>,
    getSubmitterFn: SubmitterGetter,
  ): Promise<EV5AccessManagerSubmitter> {
    const accessManagerAddress = normalizeAddressEvm(
      config.accessManagerAddress,
    );
    const caller = isNullish(config.caller)
      ? undefined
      : normalizeAddressEvm(config.caller);

    const accessManager = IAccessManager__factory.connect(
      accessManagerAddress,
      multiProvider.getProvider(config.chain),
    );

    const proposerSubmitter = await getSubmitterFn<ProtocolType.Ethereum>(
      multiProvider,
      config.proposerSubmitter,
      coreAddressesByChain,
    );

    return new EV5AccessManagerSubmitter(
      { chain: config.chain, accessManagerAddress, caller },
      multiProvider,
      proposerSubmitter,
      accessManager,
    );
  }

  async submit(
    ...txs: AnnotatedEV5Transaction[]
  ): Promise<void | EvmReceipt | EvmReceipt[]> {
    if (txs.length === 0) {
      return [];
    }

    const calls = txs.map((tx) => this.toAccessManagerCall(tx));
    this.assertNoDuplicateCalls(calls);

    const proposerTxs: AnnotatedEV5Transaction[] = [];
    const deferredExecuteTxs: AnnotatedEV5Transaction[] = [];
    const scheduledCalls: ScheduledCall[] = [];
    for (const call of calls) {
      const isTargetClosed = await this.accessManager.isTargetClosed(call.to);
      assert(
        !isTargetClosed,
        `Target ${call.to} is closed on AccessManager ${this.config.accessManagerAddress}`,
      );

      const resolution = await this.resolveCall(call);
      if (
        resolution.mode === AccessManagerCallMode.Execute &&
        (this.hasScheduledCalls || scheduledCalls.length > 0)
      ) {
        this.logger.info(
          `Deferring ${call.label} via AccessManager ${this.config.accessManagerAddress} until after the earlier scheduled calls are executed`,
        );
        deferredExecuteTxs.push(this.buildExecuteTx(call));
      } else if (resolution.mode === AccessManagerCallMode.Execute) {
        proposerTxs.push(this.buildExecuteTx(call));
      } else if (resolution.mode === AccessManagerCallMode.Schedule) {
        proposerTxs.push(this.buildScheduleTx(call));
        deferredExecuteTxs.push(this.buildExecuteTx(call));
        scheduledCalls.push({ call, resolution });
      } else {
        deferredExecuteTxs.push(this.buildExecuteTx(call));
        scheduledCalls.push({ call, resolution });
      }
    }

    if (scheduledCalls.length > 0) {
      await this.logExecutionWindows(scheduledCalls);
      // Set before the proposer submit: a partially broadcast batch must still
      // defer later immediate calls
      this.hasScheduledCalls = true;
    }

    const proposerResult =
      proposerTxs.length > 0
        ? await this.proposerSubmitter.submit(...proposerTxs)
        : undefined;
    const proposerOutput: EvmReceipt[] = !proposerResult
      ? []
      : Array.isArray(proposerResult)
        ? proposerResult
        : [proposerResult];

    // CAST: TxSubmitterInterface only models receipts as output. The deferred
    // execute txs are appended after the proposer output (same contract as
    // EV5TimelockSubmitter) so callers can persist and submit them later.
    return [...proposerOutput, ...(deferredExecuteTxs as EvmReceipt[])];
  }

  protected toAccessManagerCall(
    tx: AnnotatedEV5Transaction,
  ): AccessManagerCall {
    const { chain, accessManagerAddress } = this.config;
    const evmChainId = this.multiProvider.getEvmChainId(chain);
    const domainId = this.multiProvider.getDomainId(chain);
    assert(
      isNullish(tx.chainId) ||
        tx.chainId === evmChainId ||
        tx.chainId === domainId,
      `AccessManager transaction chainId ${tx.chainId} does not match chain ${chain} (EVM chain id ${evmChainId}, domain id ${domainId})`,
    );

    const { to, data } = tx;
    assert(to, 'Invalid Transaction: target address must be defined');
    assert(
      data && utils.isHexString(data) && utils.hexDataLength(data) >= 4,
      `Invalid Transaction: data for target ${to} must contain at least a function selector`,
    );
    assert(
      !eqAddress(to, accessManagerAddress),
      `Transactions targeting AccessManager ${accessManagerAddress} itself are not supported`,
    );

    const selector = utils.hexDataSlice(data, 0, 4);
    return {
      to,
      data,
      value: tx.value,
      selector,
      label: tx.annotation ?? `${selector} on ${to}`,
    };
  }

  protected assertNoDuplicateCalls(calls: AccessManagerCall[]): void {
    const seen = new Set<string>();
    for (const call of calls) {
      const key = `${normalizeAddressEvm(call.to)}:${call.data.toLowerCase()}`;
      assert(
        !seen.has(key),
        `Duplicate AccessManager call ${call.selector} on ${call.to}: identical (target, data) pairs share an operation id`,
      );
      seen.add(key);
    }
  }

  protected async resolveCall(
    call: AccessManagerCall,
  ): Promise<AccessManagerCallResolution> {
    const { caller, accessManagerAddress } = this.config;
    // Without a known caller, always schedule: `when = 0` makes the
    // AccessManager apply the caller's own execution delay, so a caller with no
    // delay will see the schedule tx revert on-chain.
    if (isNullish(caller)) {
      return { mode: AccessManagerCallMode.Schedule };
    }

    const [immediate, delay] = await this.accessManager.canCall(
      caller,
      call.to,
      call.selector,
    );
    if (immediate) {
      return { mode: AccessManagerCallMode.Execute };
    }

    if (delay > 0) {
      const operationId = await this.accessManager.hashOperation(
        caller,
        call.to,
        call.data,
      );
      // Returns 0 once the operation expired, so expired calls get rescheduled
      const readyAt = await this.accessManager.getSchedule(operationId);
      return readyAt === 0
        ? { mode: AccessManagerCallMode.Schedule, delay }
        : { mode: AccessManagerCallMode.AlreadyScheduled, readyAt };
    }

    const role = await this.accessManager.getTargetFunctionRole(
      call.to,
      call.selector,
    );
    const [isMember, executionDelay] = await this.accessManager.hasRole(
      role,
      caller,
    );
    throw new Error(
      `Caller ${caller} is not allowed to call ${call.selector} on ${call.to} via AccessManager ${accessManagerAddress}: function role ${role.toString()}, caller is member: ${isMember}, execution delay: ${executionDelay}s`,
    );
  }

  protected async logExecutionWindows(
    scheduledCalls: ScheduledCall[],
  ): Promise<void> {
    const expiration = await this.accessManager.expiration();
    const { timestamp } = await this.multiProvider
      .getProvider(this.config.chain)
      .getBlock('latest');
    const { accessManagerAddress } = this.config;
    for (const { call, resolution } of scheduledCalls) {
      if (resolution.mode === AccessManagerCallMode.AlreadyScheduled) {
        this.logger.info(
          `${call.label} is already scheduled via AccessManager ${accessManagerAddress}; execute from ${toIsoTime(resolution.readyAt)} and within ${expiration}s of it becoming ready`,
        );
        continue;
      }

      const readyAt = isNullish(resolution.delay)
        ? `after the caller's execution delay`
        : `from ${toIsoTime(timestamp + resolution.delay)}`;
      this.logger.info(
        `Scheduling ${call.label} via AccessManager ${accessManagerAddress}; execute ${readyAt} and within ${expiration}s of it becoming ready`,
      );
    }
  }

  protected buildScheduleTx(call: AccessManagerCall): AnnotatedEV5Transaction {
    return this.buildAccessManagerTx(
      this.accessManager.interface.encodeFunctionData('schedule', [
        call.to,
        call.data,
        0,
      ]),
      `Schedule ${call.label} via AccessManager ${this.config.accessManagerAddress}`,
    );
  }

  protected buildExecuteTx(call: AccessManagerCall): AnnotatedEV5Transaction {
    const tx = this.buildAccessManagerTx(
      this.accessManager.interface.encodeFunctionData('execute', [
        call.to,
        call.data,
      ]),
      `Execute ${call.label} via AccessManager ${this.config.accessManagerAddress}`,
    );
    if (!isNullish(call.value)) {
      tx.value = call.value;
    }
    return tx;
  }

  protected buildAccessManagerTx(
    data: string,
    annotation: string,
  ): AnnotatedEV5Transaction {
    const tx: AnnotatedEV5Transaction = {
      to: this.config.accessManagerAddress,
      data,
      chainId: this.multiProvider.getEvmChainId(this.config.chain),
      annotation,
    };
    if (!isNullish(this.config.caller)) {
      tx.from = this.config.caller;
    }
    return tx;
  }
}
