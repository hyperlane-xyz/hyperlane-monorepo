import { $ } from 'zx';

import {
  WarpCoreConfig,
  WarpRouteDeployConfigMailboxRequired,
} from '@hyperlane-xyz/sdk';
import { Address, HexString, ProtocolType } from '@hyperlane-xyz/utils';

import { CommandContext } from '../context/types.js';
import { logGray, logRed } from '../logger.js';

const LOCAL_HOST = 'http://127.0.0.1';

type ForkChainConfig = {
  impersonateAccounts: Address[];
  transactions: {
    from: Address;
    data?: HexString;
    value?: string;
    to?: Address;
  }[];
};

export async function runWarpFork({
  context,
  core,
  deployConfig,
}: {
  context: CommandContext;
  core: WarpCoreConfig;
  deployConfig: WarpRouteDeployConfigMailboxRequired;
}): Promise<void> {
  const chainsToFork = new Set([
    ...core.tokens.map((tokenConfig) => tokenConfig.chainName),
    ...Object.keys(deployConfig),
  ]);

  const filteredChainsToFork = Array.from(chainsToFork).filter(
    (chain) =>
      context.multiProvider.getProtocol(chain) === ProtocolType.Ethereum,
  );

  let port = 8545;
  for (const chainName of filteredChainsToFork) {
    const chainMetadata = await context.multiProvider.getChainMetadata(
      chainName,
    );

    const rpcUrl = chainMetadata.rpcUrls[0];

    if (!rpcUrl) {
      logRed(`Please specify either a symbol or warp config`);
      process.exit(0);
    }

    logGray(`Starting Anvil node for chain ${chainName} at port ${port}`);
    const anvilProcess = $`anvil --port ${port} --chain-id ${chainMetadata.chainId} --fork-url ${rpcUrl.http}`;
    logGray(
      `Running Anvil node for chain ${chainName} at ${LOCAL_HOST}:${port}`,
    );

    process.once('exit', () => anvilProcess.kill());
    port++;

    const provider = context.multiProvider.getProvider(chainName);
  }
}
