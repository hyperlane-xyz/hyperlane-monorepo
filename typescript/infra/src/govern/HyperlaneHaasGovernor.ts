import chalk from 'chalk';

import {
  ChainName,
  CheckerViolation,
  CoreConfig,
  HyperlaneCore,
  HyperlaneCoreChecker,
  InterchainAccount,
  ViolationType,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import { chainsToSkip } from '../config/chain.js';

import {
  AnnotatedCallData,
  HyperlaneAppGovernor,
} from './HyperlaneAppGovernor.js';
import { HyperlaneCoreGovernor } from './HyperlaneCoreGovernor.js';
import { HyperlaneICAChecker } from './HyperlaneICAChecker.js';
import { ProxiedRouterGovernor } from './ProxiedRouterGovernor.js';

export class HyperlaneHaasGovernor extends HyperlaneAppGovernor<
  HyperlaneCore,
  CoreConfig
> {
  protected readonly icaGovernor: ProxiedRouterGovernor<any, any>;
  protected readonly coreGovernor: HyperlaneCoreGovernor;

  constructor(
    ica: InterchainAccount,
    private readonly icaChecker: HyperlaneICAChecker,
    private readonly coreChecker: HyperlaneCoreChecker,
  ) {
    super(coreChecker, ica);

    this.icaGovernor = new ProxiedRouterGovernor(this.icaChecker);
    this.coreGovernor = new HyperlaneCoreGovernor(this.coreChecker, this.ica);
  }

  protected mapViolationToCall(
    _: CheckerViolation,
  ): Promise<{ chain: string; call: AnnotatedCallData } | undefined> {
    throw new Error(`HyperlaneHaasGovernor has no native map of violations.`);
  }

  // Handle ICA violations before Core violations
  protected async mapViolationsToCalls(): Promise<void> {
    // Handle ICA violations first
    const icaCallObjs = await Promise.all(
      this.icaChecker.violations.map((violation) =>
        this.icaGovernor.mapViolationToCall(violation),
      ),
    );

    // Process ICA call objects
    for (const callObj of icaCallObjs) {
      if (callObj) {
        this.pushCall(callObj.chain, callObj.call);
      }
    }

    // Then handle Core violations
    const coreCallObjs = await Promise.all(
      this.coreChecker.violations.map((violation) =>
        this.coreGovernor.mapViolationToCall(violation),
      ),
    );

    // Process Core call objects
    for (const callObj of coreCallObjs) {
      if (callObj) {
        this.pushCall(callObj.chain, callObj.call);
      }
    }
  }

  async check(chainsToCheck?: ChainName[]) {
    // Get all EVM chains from core config
    const evmChains = this.coreChecker.getEvmChains();

    // Mark any EVM chains that are not deployed
    const appChains = this.coreChecker.app.chains();
    for (const chain of evmChains) {
      if (!appChains.includes(chain)) {
        this.coreChecker.addViolation({
          type: ViolationType.NotDeployed,
          chain,
          expected: '',
          actual: '',
        });
      }
    }

    // Finally, check the chains that were explicitly requested
    // If no chains were requested, check all app chains
    const chains =
      !chainsToCheck || chainsToCheck.length === 0 ? appChains : chainsToCheck;
    const failedChains: ChainName[] = [];
    if (chainsToSkip.length > 0) {
      rootLogger.info(
        chalk.yellow('Skipping chains:', chainsToSkip.join(', ')),
      );
    }
    await Promise.allSettled(
      chains
        .filter(
          (chain) =>
            this.coreChecker.multiProvider.getChainMetadata(chain).protocol ===
              ProtocolType.Ethereum && !chainsToSkip.includes(chain),
        )
        .map(async (chain) => {
          try {
            await this.checkChain(chain);
          } catch (err) {
            rootLogger.error(chalk.red(`Failed to check chain ${chain}:`, err));
            failedChains.push(chain);
          }
        }),
    );

    if (failedChains.length > 0) {
      rootLogger.error(chalk.red('Failed chains:', failedChains.join(', ')));
    }
  }

  async checkChain(chain: ChainName) {
    await this.icaChecker.checkChain(chain);
    await this.coreChecker.checkChain(chain);
  }

  getCheckerViolations() {
    return [...this.icaChecker.violations, ...this.coreChecker.violations];
  }

  async govern(confirm = true, chain?: ChainName) {
    const totalViolations =
      this.icaChecker.violations.length + this.coreChecker.violations.length;
    if (totalViolations === 0) return;

    // 1. Map violations to calls
    await this.mapViolationsToCalls();

    // 2. For each call, infer how it should be submitted on-chain.
    await this.inferCallSubmissionTypes();

    // 3. Prompt the user to confirm that the count, description,
    // and submission methods look correct before submitting.
    const chains = chain ? [chain] : Object.keys(this.calls);
    for (const chain of chains) {
      await this.sendCalls(chain, confirm);
    }
  }
}
