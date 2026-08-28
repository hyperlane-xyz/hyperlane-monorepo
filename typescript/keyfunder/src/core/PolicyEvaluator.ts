import { ethers } from 'ethers';
import {
  ChainBalanceReport,
  ChainFundingConfig,
  FunderConfig,
  FundingAction,
  FundingPolicy,
  KeyfunderConfig,
  RecipientConfig,
  StrategyType,
} from '../types';
import { getDefaultDecimals, getDefaultSymbol } from '../config/schema';

export class PolicyEvaluator {
  /**
   * Helper to format units
   */
  private formatUnits(amount: bigint, decimals: number): string {
    return ethers.formatUnits(amount, decimals);
  }

  /**
   * Helper to parse units
   */
  private parseUnits(amountStr: string, decimals: number): bigint {
    try {
      return ethers.parseUnits(amountStr, decimals);
    } catch {
      return 0n;
    }
  }

  /**
   * Resolve effective funding policy for a recipient
   */
  public resolvePolicy(
    recipient: RecipientConfig,
    policies?: Record<string, FundingPolicy>
  ): FundingPolicy {
    let basePolicy: FundingPolicy = {
      minBalance: '0',
      desiredBalance: '0',
    };

    if (recipient.policy && policies && policies[recipient.policy]) {
      basePolicy = { ...policies[recipient.policy] };
    }

    return {
      minBalance: recipient.minBalance ?? basePolicy.minBalance,
      desiredBalance: recipient.desiredBalance ?? basePolicy.desiredBalance,
      maxFundingAmount: recipient.maxFundingAmount ?? basePolicy.maxFundingAmount,
    };
  }

  /**
   * Resolve minimum reserve floor for funder on this chain
   */
  public resolveFunderMinReserve(
    chainName: string,
    chainConfig: ChainFundingConfig,
    funderConfig?: FunderConfig
  ): string {
    if (chainConfig.funderMinReserve !== undefined) {
      return chainConfig.funderMinReserve;
    }

    if (funderConfig?.minReserve) {
      if (typeof funderConfig.minReserve === 'string') {
        return funderConfig.minReserve;
      }
      if (typeof funderConfig.minReserve === 'object' && funderConfig.minReserve[chainName]) {
        return funderConfig.minReserve[chainName];
      }
    }

    return '0';
  }

  /**
   * Evaluate funding actions for a single chain
   */
  public evaluateChain(
    chainName: string,
    chainConfig: ChainFundingConfig,
    report: ChainBalanceReport,
    policies?: Record<string, FundingPolicy>,
    funderConfig?: FunderConfig
  ): FundingAction[] {
    const decimals = chainConfig.nativeDecimals ?? getDefaultDecimals(chainConfig.protocol);
    const symbol = chainConfig.nativeSymbol ?? getDefaultSymbol(chainConfig.protocol);

    const minReserveStr = this.resolveFunderMinReserve(chainName, chainConfig, funderConfig);
    const minReserveBigInt = this.parseUnits(minReserveStr, decimals);

    let simulatedFunderBalance = report.funderBalance;
    const actions: FundingAction[] = [];

    for (const recipientReport of report.recipientBalances) {
      const recipientConfig = chainConfig.recipients.find(
        (r) => r.address.toLowerCase() === recipientReport.recipient.toLowerCase()
      ) || {
        address: recipientReport.recipient,
        name: recipientReport.name,
      };

      const policy = this.resolvePolicy(recipientConfig, policies);
      const minThresholdBigInt = this.parseUnits(policy.minBalance, decimals);
      const desiredBalanceBigInt = this.parseUnits(policy.desiredBalance, decimals);
      const maxFundingBigInt = policy.maxFundingAmount
        ? this.parseUnits(policy.maxFundingAmount, decimals)
        : undefined;

      const strategy: StrategyType =
        recipientConfig.strategy || chainConfig.strategy || 'direct';

      const currentBalance = recipientReport.balance;
      let requiredFunding = 0n;
      let status: FundingAction['status'] = 'SKIPPED';
      let skipReason: string | undefined;

      if (currentBalance < minThresholdBigInt) {
        // Calculate deficit
        let deficit = desiredBalanceBigInt > currentBalance ? desiredBalanceBigInt - currentBalance : 0n;
        if (maxFundingBigInt !== undefined && deficit > maxFundingBigInt) {
          deficit = maxFundingBigInt;
        }
        requiredFunding = deficit;

        // Check funder balance against minimum reserve floor
        if (simulatedFunderBalance <= minReserveBigInt) {
          status = 'SKIPPED';
          skipReason = `Funder balance (${this.formatUnits(report.funderBalance, decimals)} ${symbol}) at or below reserve floor (${minReserveStr} ${symbol})`;
        } else {
          const availableReserve = simulatedFunderBalance - minReserveBigInt;
          if (requiredFunding > availableReserve) {
            // Cap funding to available reserve if partial funding is possible
            if (availableReserve > 0n) {
              requiredFunding = availableReserve;
              simulatedFunderBalance -= requiredFunding;
              status = 'PENDING';
            } else {
              status = 'SKIPPED';
              skipReason = `Insufficient funder reserve for ${recipientReport.recipient}`;
            }
          } else {
            simulatedFunderBalance -= requiredFunding;
            status = 'PENDING';
          }
        }
      } else {
        status = 'SKIPPED';
        skipReason = `Balance (${this.formatUnits(currentBalance, decimals)} ${symbol}) >= minThreshold (${policy.minBalance} ${symbol})`;
      }

      actions.push({
        chain: chainName,
        protocol: chainConfig.protocol,
        recipient: recipientReport.recipient,
        recipientName: recipientConfig.name || recipientReport.name,
        currentBalance,
        formattedCurrentBalance: this.formatUnits(currentBalance, decimals),
        minThreshold: minThresholdBigInt,
        formattedMinThreshold: policy.minBalance,
        desiredBalance: desiredBalanceBigInt,
        formattedDesiredBalance: policy.desiredBalance,
        requiredFunding,
        formattedRequiredFunding: this.formatUnits(requiredFunding, decimals),
        funderAddress: report.funderAddress,
        funderBalance: report.funderBalance,
        formattedFunderBalance: report.formattedFunderBalance,
        strategy,
        status,
        skipReason,
        decimals,
        symbol,
        tokenAddress: recipientConfig.tokenAddress,
        tokenDenom: recipientConfig.tokenDenom,
      });
    }

    return actions;
  }

  /**
   * Evaluate all chains in configuration
   */
  public evaluateAll(
    config: KeyfunderConfig,
    reports: Record<string, ChainBalanceReport>
  ): FundingAction[] {
    const rootFunder = config.funder || config.globalFunderKey;
    const allActions: FundingAction[] = [];

    for (const [chainName, chainConfig] of Object.entries(config.chains)) {
      const report = reports[chainName];
      if (!report) continue;

      const effectiveFunder = chainConfig.funderKey || rootFunder;
      const actions = this.evaluateChain(
        chainName,
        chainConfig,
        report,
        config.policies,
        effectiveFunder
      );
      allActions.push(...actions);
    }

    return allActions;
  }
}
