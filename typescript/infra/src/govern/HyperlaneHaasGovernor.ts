import {
  ChainName,
  CheckerViolation,
  HyperlaneCoreChecker,
  InterchainAccount,
  InterchainAccountChecker,
} from '@hyperlane-xyz/sdk';

import {
  AnnotatedCallData,
  HyperlaneAppGovernor,
} from './HyperlaneAppGovernor.js';
import { HyperlaneCoreGovernor } from './HyperlaneCoreGovernor.js';
import { ProxiedRouterGovernor } from './ProxiedRouterGovernor.js';

export class HyperlaneHaasGovernor extends HyperlaneAppGovernor<any, any> {
  protected readonly icaGovernor: ProxiedRouterGovernor<any, any>;
  protected readonly coreGovernor: HyperlaneCoreGovernor;

  constructor(
    ica: InterchainAccount,
    private readonly icaChecker: InterchainAccountChecker,
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
    // Handle ICA and Core checker violations in parallel
    const [icaCallObjs, coreCallObjs] = await Promise.all([
      Promise.all(
        this.icaChecker.violations.map((violation) =>
          this.icaGovernor.mapViolationToCall(violation),
        ),
      ),
      Promise.all(
        this.coreChecker.violations.map((violation) =>
          this.coreGovernor.mapViolationToCall(violation),
        ),
      ),
    ]);

    // Process ICA call objects
    for (const callObj of icaCallObjs) {
      if (callObj) {
        this.pushCall(callObj.chain, callObj.call);
      }
    }

    // Process Core call objects
    for (const callObj of coreCallObjs) {
      if (callObj) {
        this.pushCall(callObj.chain, callObj.call);
      }
    }
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
