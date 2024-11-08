import { OriginDestinationSignerStrategy } from './OriginDestinationSignerStrategy.js';
import { SignerStrategy } from './SignerStrategy.js';
import { SingleChainSignerStrategy } from './SingleChainSignerStrategy.js';
import { WarpDeploySignerStrategy } from './WarpDeploySignerStrategy.js';

export class SignerStrategyFactory {
  static createStrategy(argv: Record<string, any>): SignerStrategy {
    const strategyMap: Record<string, () => SignerStrategy> = {
      'core:apply': () => new SingleChainSignerStrategy(),
      'warp:deploy': () => new WarpDeploySignerStrategy(),
      'warp:send': () => new WarpDeploySignerStrategy(), // Assuming same strategy for 'send'
      'warp:apply': () => new WarpDeploySignerStrategy(), // Assuming same strategy for 'appl'
      'send:message': () => new OriginDestinationSignerStrategy(),
    };

    const commandKey = `${argv._[0]}:${argv._[1] || ''}`.trim();

    const createStrategy =
      strategyMap[commandKey] || (() => new SingleChainSignerStrategy());

    return createStrategy();
  }
}
