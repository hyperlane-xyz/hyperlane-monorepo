import { CommandType } from '../../../commands/signCommands.js';

import { MultiChainResolver } from './MultiChainResolver.js';
import { ChainResolver } from './types.js';

/**
 * @class ChainResolverFactory
 * @description Intercepts commands to determine the appropriate chain resolver strategy based on command type.
 */
export class ChainResolverFactory {
  private static strategyMap: Map<CommandType, () => ChainResolver> = new Map([
    [CommandType.WARP_DEPLOY, () => MultiChainResolver.forWarpRouteConfig()],
    // Using the forRelayer resolver because warp send allows the user to self relay the tx
    [CommandType.WARP_SEND, () => MultiChainResolver.forRelayer()],
    [CommandType.WARP_APPLY, () => MultiChainResolver.forWarpApply()],
    // Using the forRelayer resolver because send allows the user to self relay the tx
    [CommandType.SEND_MESSAGE, () => MultiChainResolver.forRelayer()],
    [CommandType.AGENT_KURTOSIS, () => MultiChainResolver.forAgentKurtosis()],
    // Using the forRelayer resolver because status allows the user to self relay the tx
    [CommandType.STATUS, () => MultiChainResolver.forRelayer()],
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
      this.strategyMap.get(commandKey) || (() => MultiChainResolver.default());
    return createStrategy();
  }
}
