import { FundingAction, FundingExecutionResult, StrategyExecutionContext } from '../types';

export interface IFundingStrategy {
  readonly name: string;
  execute(
    action: FundingAction,
    context: StrategyExecutionContext,
    signerContext?: any
  ): Promise<FundingExecutionResult>;
}
