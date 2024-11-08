import {
  ChainName,
  ChainSubmissionStrategy,
  MultiProvider,
  TxSubmitterType,
} from '@hyperlane-xyz/sdk';

import { runSingleChainSelectionStep } from '../../../utils/chains.js';
import { ContextManager } from '../../manager/ContextManager.js';

import { SignerStrategy } from './SignerStrategy.js';

export class OriginDestinationSignerStrategy implements SignerStrategy {
  async determineChains(argv: Record<string, any>): Promise<ChainName[]> {
    const { context } = argv;
    let origin = argv.origin;
    let destination = argv.destination;

    if (!origin) {
      origin = await runSingleChainSelectionStep(
        context.chainMetadata,
        'Select the origin chain',
      );
    }

    if (!destination) {
      destination = await runSingleChainSelectionStep(
        context.chainMetadata,
        'Select the destination chain',
      );
    }
    const chains = [origin, destination];
    argv.chains = chains;
    argv.origin = origin;
    argv.destination = origin;
    return chains; // Explicitly return as single-item array
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
