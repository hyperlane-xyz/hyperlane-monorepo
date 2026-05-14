import {
  TOKEN_COLLATERALIZED_STANDARDS,
  WarpCore,
  type WarpCoreConfig,
} from '@hyperlane-xyz/sdk';
import { type Address } from '@hyperlane-xyz/utils';

import { type CommandContext } from '../context/types.js';
import { logBlue, logGreen, logTable, warnYellow } from '../logger.js';
import { writeYamlOrJson } from '../utils/files.js';
import { getWarpCoreConfigOrExit } from '../utils/warp.js';

interface BalanceRow {
  Symbol: string;
  Standard: string;
  Address: string;
  Balance: string;
}

export async function runWarpRouteBalances({
  context,
  warpRouteId,
  chains,
  out,
}: {
  context: CommandContext;
  warpRouteId?: string;
  chains?: string[];
  out?: string;
}): Promise<void> {
  const warpCoreConfig: WarpCoreConfig = await getWarpCoreConfigOrExit({
    context,
    warpRouteId,
    chains,
  });

  const registryAddresses = await context.registry.getAddresses();
  const mailboxMetadata: Record<string, { mailbox?: Address }> = {};
  for (const token of warpCoreConfig.tokens) {
    const chainAddresses = registryAddresses[token.chainName];
    if (chainAddresses?.mailbox) {
      mailboxMetadata[token.chainName] = { mailbox: chainAddresses.mailbox };
    }
  }
  const multiProvider =
    context.multiProtocolProvider.extendChainMetadata(mailboxMetadata);

  const warpCore = WarpCore.FromConfig(multiProvider, warpCoreConfig);

  const collateralizedSet = new Set(TOKEN_COLLATERALIZED_STANDARDS);

  const rowEntries: [string, BalanceRow][] = await Promise.all(
    warpCore.tokens.map(async (token) => {
      const isCollateral = collateralizedSet.has(token.standard);

      try {
        let balanceRaw: bigint | undefined;

        if (isCollateral) {
          balanceRaw = await warpCore.getTokenCollateral(token);
        } else {
          const adapter = token.getAdapter(multiProvider);
          balanceRaw = await adapter.getTotalSupply();
        }

        const balance =
          balanceRaw !== undefined
            ? (Number(balanceRaw) / 10 ** token.decimals).toLocaleString(
                undefined,
                { maximumFractionDigits: token.decimals },
              )
            : 'N/A';

        return [
          token.chainName,
          {
            Symbol: token.symbol,
            Standard: token.standard,
            Address: token.addressOrDenom,
            Balance: balance,
          },
        ];
      } catch (e) {
        warnYellow(
          `Could not fetch balance for ${token.symbol} on ${token.chainName}: ${e}`,
        );
        return [
          token.chainName,
          {
            Symbol: token.symbol,
            Standard: token.standard,
            Address: token.addressOrDenom,
            Balance: 'Error',
          },
        ];
      }
    }),
  );

  const tableData = Object.fromEntries(rowEntries);

  logBlue('\nWarp route balances:');
  logTable(tableData);

  if (out) {
    const jsonData = rowEntries.map(([chain, row]) => ({ chain, ...row }));
    writeYamlOrJson(out, jsonData);
    logGreen(`\nBalances written to ${out}`);
  }
}
