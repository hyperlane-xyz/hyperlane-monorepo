import {
  ERC4626_COLLATERAL_STANDARDS,
  TOKEN_COLLATERALIZED_STANDARDS,
  WarpCore,
  type WarpCoreConfig,
} from '@hyperlane-xyz/sdk';
import { type Address } from '@hyperlane-xyz/utils';

import { type CommandContext } from '../context/types.js';
import { logBlue, logGreen, logTable, warnYellow } from '../logger.js';
import { writeYamlOrJson } from '../utils/files.js';
import { getWarpCoreConfigOrExit } from '../utils/warp.js';

function formatBigIntBalance(raw: bigint, decimals: number): string {
  const str = raw.toString().padStart(decimals + 1, '0');
  const intPart = str.slice(0, str.length - decimals);
  const fracFull = str.slice(str.length - decimals);
  const fracTrimmed = fracFull.replace(/0+$/, '');
  const intFormatted = new Intl.NumberFormat().format(BigInt(intPart));
  return fracTrimmed ? `${intFormatted}.${fracTrimmed}` : intFormatted;
}

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

  const collateralizedSet = new Set([
    ...TOKEN_COLLATERALIZED_STANDARDS,
    ...ERC4626_COLLATERAL_STANDARDS,
  ]);

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
            ? formatBigIntBalance(balanceRaw, token.decimals)
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
      } catch (e: unknown) {
        warnYellow(
          `Could not fetch balance for ${token.symbol} on ${token.chainName}: ${e instanceof Error ? e.message : String(e)}`,
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

  const tableData: Record<string, BalanceRow> = {};
  for (const [chain, row] of rowEntries) {
    let key = chain;
    let i = 2;
    while (key in tableData) {
      key = `${chain} (${i++})`;
    }
    tableData[key] = row;
  }

  logBlue('\nWarp route balances:');
  logTable(tableData);

  if (out) {
    const jsonData = rowEntries.map(([chain, row]) => ({ chain, ...row }));
    writeYamlOrJson(out, jsonData);
    logGreen(`\nBalances written to ${out}`);
  }
}
