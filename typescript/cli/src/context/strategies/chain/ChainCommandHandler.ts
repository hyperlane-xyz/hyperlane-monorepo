import { MultiChainHandler } from './MultiChainHandler.js';
import { SingleChainHandler } from './SingleChainHandler.js';
import { ChainHandler } from './types.js';

enum CommandType {
  CORE_APPLY = 'core:apply',
  WARP_DEPLOY = 'warp:deploy',
  WARP_SEND = 'warp:send',
  WARP_APPLY = 'warp:apply',
  WARP_READ = 'warp:read',
  SEND_MESSAGE = 'send:message',
  AGENT_KURTOSIS = 'deploy:kurtosis-agents',
  STATUS = 'status:',
}

export class ChainCommandHandler {
  private static strategyMap: Map<CommandType, () => ChainHandler> = new Map([
    [CommandType.CORE_APPLY, () => new SingleChainHandler()],
    [CommandType.WARP_DEPLOY, () => MultiChainHandler.forWarpConfig()],
    [CommandType.WARP_SEND, () => MultiChainHandler.forOriginDestination()],
    [CommandType.WARP_APPLY, () => MultiChainHandler.forWarpConfig()],
    [CommandType.WARP_READ, () => new SingleChainHandler()],
    [CommandType.SEND_MESSAGE, () => MultiChainHandler.forOriginDestination()],
    [CommandType.AGENT_KURTOSIS, () => MultiChainHandler.forAgentKurtosis()],
    [CommandType.STATUS, () => MultiChainHandler.forOriginDestination()],
  ]);

  static getHandler(argv: Record<string, any>): ChainHandler {
    const commandKey = `${argv._[0]}:${argv._[1] || ''}`.trim() as CommandType;
    const createStrategy =
      this.strategyMap.get(commandKey) || (() => new SingleChainHandler());
    return createStrategy();
  }
}
