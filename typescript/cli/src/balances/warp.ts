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

interface TokenEntry {
  chain: string;
  row: BalanceRow;
  rawBalance: bigint | undefined;
  isCollateral: boolean;
  decimals: number;
}

export async function runWarpRouteBalances({
  context,
  warpRouteId,
  chains,
  out,
  address,
  raw,
}: {
  context: CommandContext;
  warpRouteId?: string;
  chains?: string[];
  out?: string;
  address?: string;
  raw?: boolean;
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

  const tokenEntries: TokenEntry[] = await Promise.all(
    warpCore.tokens.map(async (token) => {
      const isCollateral = collateralizedSet.has(token.standard);

      try {
        let balanceRaw: bigint | undefined;

        if (address) {
          const adapter = token.getAdapter(multiProvider);
          balanceRaw = await adapter.getBalance(address);
        } else if (isCollateral) {
          balanceRaw = await warpCore.getTokenCollateral(token);
        } else {
          const adapter = token.getAdapter(multiProvider);
          balanceRaw = await adapter.getTotalSupply();
        }

        const balance =
          balanceRaw !== undefined
            ? raw
              ? balanceRaw.toString()
              : formatBigIntBalance(balanceRaw, token.decimals)
            : 'N/A';

        return {
          chain: token.chainName,
          row: {
            Symbol: token.symbol,
            Standard: token.standard,
            Address: token.addressOrDenom,
            Balance: balance,
          },
          rawBalance: balanceRaw,
          isCollateral,
          decimals: token.decimals,
        };
      } catch (e: unknown) {
        warnYellow(
          `Could not fetch balance for ${token.symbol} on ${token.chainName}: ${e instanceof Error ? e.message : String(e)}`,
        );
        return {
          chain: token.chainName,
          row: {
            Symbol: token.symbol,
            Standard: token.standard,
            Address: token.addressOrDenom,
            Balance: 'Error',
          },
          rawBalance: undefined,
          isCollateral,
          decimals: token.decimals,
        };
      }
    }),
  );

  const tableData: Record<string, BalanceRow> = {};
  for (const { chain, row } of tokenEntries) {
    let key = chain;
    let i = 2;
    while (key in tableData) {
      key = `${chain} (${i++})`;
    }
    tableData[key] = row;
  }

  if (address) {
    logBlue(`\nWarp route balances for ${address}:`);
  } else {
    logBlue('\nWarp route balances:');
  }
  logTable(tableData);

  if (!address) {
    const collateralEntries = tokenEntries.filter((e) => e.isCollateral);
    const syntheticEntries = tokenEntries.filter((e) => !e.isCollateral);

    if (collateralEntries.length > 0 && syntheticEntries.length > 0) {
      const hasErrors = tokenEntries.some((e) => e.rawBalance === undefined);

      const commonDecimals = Math.max(
        ...collateralEntries.map((e) => e.decimals),
        ...syntheticEntries.map((e) => e.decimals),
      );
      const scale = (e: TokenEntry) =>
        10n ** BigInt(commonDecimals - e.decimals);
      const totalCollateral = collateralEntries.reduce(
        (sum, e) => sum + (e.rawBalance ?? 0n) * scale(e),
        0n,
      );
      const totalSynthetic = syntheticEntries.reduce(
        (sum, e) => sum + (e.rawBalance ?? 0n) * scale(e),
        0n,
      );

      const fmt = (v: bigint) =>
        raw ? v.toString() : formatBigIntBalance(v, commonDecimals);

      if (totalCollateral === totalSynthetic) {
        logGreen(
          `\nStatus: collateral matches synthetic supply (${fmt(totalCollateral)})${hasErrors ? ' [some balances unavailable]' : ''}`,
        );
      } else {
        const diff =
          totalCollateral > totalSynthetic
            ? totalCollateral - totalSynthetic
            : totalSynthetic - totalCollateral;
        const sign = totalCollateral > totalSynthetic ? '+' : '-';
        warnYellow(
          `\nStatus: MISMATCH — collateral ${fmt(totalCollateral)} vs synthetic ${fmt(totalSynthetic)} (diff: ${sign}${fmt(diff)})${hasErrors ? ' [some balances unavailable]' : ''}`,
        );
      }
    }
  }

  if (out) {
    const jsonData = tokenEntries.map(({ chain, row }) => ({ chain, ...row }));
    writeYamlOrJson(out, jsonData);
    logGreen(`\nBalances written to ${out}`);
  }
}
