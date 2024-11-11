import { OriginDestinationSignerStrategy } from './OriginDestinationSignerStrategy.js';
import { SignerStrategy } from './SignerStrategy.js';
import { SingleChainSignerStrategy } from './SingleChainSignerStrategy.js';
import { WarpConfigSignerStrategy } from './WarpConfigSignerStrategy.js';

enum CommandType {
  CORE_APPLY = 'core:apply',
  WARP_DEPLOY = 'warp:deploy',
  WARP_SEND = 'warp:send',
  WARP_APPLY = 'warp:apply',
  WARP_READ = 'warp:read',
  WARP_MESSAGE = 'send:message',
}

export class SignerStrategyFactory {
  private static strategyMap: Map<CommandType, () => SignerStrategy> = new Map([
    [CommandType.CORE_APPLY, () => new SingleChainSignerStrategy()],
    [CommandType.WARP_DEPLOY, () => new WarpConfigSignerStrategy()],
    [CommandType.WARP_SEND, () => new OriginDestinationSignerStrategy()],
    [CommandType.WARP_APPLY, () => new WarpConfigSignerStrategy()],
    [CommandType.WARP_READ, () => new SingleChainSignerStrategy()],
    [CommandType.WARP_MESSAGE, () => new OriginDestinationSignerStrategy()],
  ]);

  static createStrategy(argv: Record<string, any>): SignerStrategy {
    const commandKey = `${argv._[0]}:${argv._[1] || ''}`.trim() as CommandType;
    const createStrategy =
      this.strategyMap.get(commandKey) ||
      (() => new SingleChainSignerStrategy());
    return createStrategy();
  }
}
