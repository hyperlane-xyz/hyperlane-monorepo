import {
  ChainName,
  ChainSubmissionStrategy,
  MultiProvider,
  TxSubmitterType,
} from '@hyperlane-xyz/sdk';

import { runSingleChainSelectionStep } from '../../../utils/chains.js';
import { ContextManager } from '../../manager/ContextManager.js';

import { SignerStrategy } from './SignerStrategy.js';

export class SingleChainSignerStrategy implements SignerStrategy {
  async determineChains(argv: Record<string, any>): Promise<ChainName[]> {
    const chain: ChainName =
      argv.chain ||
      (await runSingleChainSelectionStep(
        argv.context.chainMetadata,
        'Select chain to connect:',
      ));

    argv.chain = chain;
    return [chain]; // Explicitly return as single-item array
  }

  createContextManager(
    chains: ChainName[],
    strategyConfig: ChainSubmissionStrategy,
    argv?: any,
  ): ContextManager {
    return new ContextManager(
      strategyConfig,
      chains,
      TxSubmitterType.JSON_RPC,
      argv,
    );
  }

  async configureSigners(
    argv: Record<string, any>,
    multiProvider: MultiProvider,
    contextManager: ContextManager,
  ): Promise<void> {
    const signers = await contextManager.getSigners();
    multiProvider.setSigners(signers);
    argv.context.multiProvider = multiProvider;
    argv.contextManager = contextManager;
  }
}
