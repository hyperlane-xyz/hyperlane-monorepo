import { MultiChainResolver } from './MultiChainResolver.js';
import { SingleChainResolver } from './SingleChainResolver.js';
import { ChainResolver } from './types.js';

enum CommandType {
  WARP_DEPLOY = 'warp:deploy',
  WARP_SEND = 'warp:send',
  WARP_APPLY = 'warp:apply',
  WARP_READ = 'warp:read',
  SEND_MESSAGE = 'send:message',
  AGENT_KURTOSIS = 'deploy:kurtosis-agents',
  STATUS = 'status:',
  SUBMIT = 'submit:',
  RELAYER = 'relayer:',
}

/**
 * @class ChainResolverFactory
 * @description Intercepts commands to determine the appropriate chain resolver strategy based on command type.
 */
export class ChainResolverFactory {
  private static strategyMap: Map<CommandType, () => ChainResolver> = new Map([
    [CommandType.WARP_DEPLOY, () => MultiChainResolver.forWarpRouteConfig()],
    [CommandType.WARP_SEND, () => MultiChainResolver.forOriginDestination()],
    [CommandType.WARP_APPLY, () => MultiChainResolver.forWarpRouteConfig()],
    [CommandType.WARP_READ, () => MultiChainResolver.forWarpCoreConfig()],
    [CommandType.SEND_MESSAGE, () => MultiChainResolver.forOriginDestination()],
    [CommandType.AGENT_KURTOSIS, () => MultiChainResolver.forAgentKurtosis()],
    [CommandType.STATUS, () => MultiChainResolver.forOriginDestination()],
    [CommandType.SUBMIT, () => MultiChainResolver.forStrategyConfig()],
    [CommandType.RELAYER, () => MultiChainResolver.forRelayer()],
  ]);

  /**
   * @param argv - Command line arguments.
   * @returns ChainResolver - The appropriate chain resolver strategy based on the command type.
   */
  static getStrategy(argv: Record<string, any>): ChainResolver {
    const commandKey = `${argv._[0]}:${argv._[1] || ''}`.trim() as CommandType;
    const createStrategy =
      this.strategyMap.get(commandKey) || (() => new SingleChainResolver());
    return createStrategy();
  }
}
