import { CommandType } from '../../../commands/signCommands.js';

import { MultiChainResolver } from './MultiChainResolver.js';
import { SingleChainResolver } from './SingleChainResolver.js';
import { ChainResolver } from './types.js';

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
    [CommandType.WARP_CHECK, () => MultiChainResolver.forWarpCoreConfig()],
    [CommandType.SEND_MESSAGE, () => MultiChainResolver.forOriginDestination()],
    [CommandType.AGENT_KURTOSIS, () => MultiChainResolver.forAgentKurtosis()],
    [CommandType.STATUS, () => MultiChainResolver.forOriginDestination()],
    [CommandType.SUBMIT, () => MultiChainResolver.forStrategyConfig()],
    [CommandType.RELAYER, () => MultiChainResolver.forRelayer()],
    [CommandType.CORE_APPLY, () => MultiChainResolver.forCoreApply()],
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
