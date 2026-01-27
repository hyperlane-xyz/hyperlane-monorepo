import { ethers } from 'ethers';

import {
  type ChainMap,
  CoinGeckoTokenPriceGetter,
  WarpCore,
  type WarpCoreConfig,
} from '@hyperlane-xyz/sdk';
import { type Address, ProtocolType, toWei } from '@hyperlane-xyz/utils';

import { type CommandContext } from '../context/types.js';
import {
  logBlue,
  logCommandHeader,
  logGreen,
  logTable,
  warnYellow,
} from '../logger.js';
import { ENV } from '../utils/env.js';
import { getWarpCoreConfigOrExit } from '../utils/warp.js';

interface FeeRow {
  Origin: string;
  Destination: string;
  'Fee Amount': string;
  'Fee Token': string;
  'USD Cost': string;
}

// Placeholder addresses for different protocol types (for fee quotes)
// Note: Sealevel fee quotes require a funded sender for transaction simulation,
// so we use the Hyperlane relayer account as a known funded address
const PLACEHOLDER_ADDRESSES: Record<ProtocolType, string> = {
  [ProtocolType.Ethereum]: ethers.constants.AddressZero,
  [ProtocolType.Sealevel]: 'G5FM3UKwcBJ47PwLWLLY1RQpqNtTMgnqnd6nZGcJqaBp', // Hyperlane relayer (funded)
  [ProtocolType.Cosmos]: 'cosmos1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqnrql8a',
  [ProtocolType.CosmosNative]: 'cosmos1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqnrql8a',
  [ProtocolType.Starknet]: '0x0',
  [ProtocolType.Aleo]:
    'aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3ljyzc',
  [ProtocolType.Radix]:
    'resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd',
};

export async function runWarpRouteFees({
  context,
  symbol,
  warpCoreConfigPath,
  warpRouteId,
  amount,
}: {
  context: CommandContext;
  symbol?: string;
  warpCoreConfigPath?: string;
  warpRouteId?: string;
  amount: string;
}): Promise<void> {
  logCommandHeader('Hyperlane Warp Route Fees');

  // Load warp core config
  const warpCoreConfig: WarpCoreConfig = await getWarpCoreConfigOrExit({
    context,
    symbol,
    warp: warpCoreConfigPath,
    warpRouteId,
  });

  // Get registry addresses and extend multiProtocolProvider with mailbox metadata
  // This is needed for Sealevel chains which require mailbox address for fee quotes
  const registryAddresses = await context.registry.getAddresses();
  const mailboxMetadata: ChainMap<{ mailbox?: Address }> = {};
  for (const token of warpCoreConfig.tokens) {
    const chainAddresses = registryAddresses[token.chainName];
    if (chainAddresses?.mailbox) {
      mailboxMetadata[token.chainName] = { mailbox: chainAddresses.mailbox };
    }
  }
  const multiProviderWithMailbox =
    context.multiProtocolProvider.extendChainMetadata(mailboxMetadata);

  // Create WarpCore
  const warpCore = WarpCore.FromConfig(
    multiProviderWithMailbox,
    warpCoreConfig,
  );

  // Create price getter (optional)
  let priceGetter: CoinGeckoTokenPriceGetter | undefined;
  const coingeckoApiKey = ENV.COINGECKO_API_KEY;
  try {
    priceGetter = new CoinGeckoTokenPriceGetter({
      chainMetadata: context.chainMetadata,
      apiKey: coingeckoApiKey,
      sleepMsBetweenRequests: 500,
    });
  } catch (_e) {
    warnYellow(
      'Could not initialize CoinGecko price getter, USD prices will not be shown',
    );
  }

  // Collect fee data for all routes
  const feeRows: FeeRow[] = [];
  // Track total USD costs for matrix display: origin -> destination -> cost
  const totalUsdMatrix: Record<string, Record<string, string>> = {};

  for (const token of warpCore.tokens) {
    const connections = token.getConnections();

    for (const connection of connections) {
      const destChain = connection.token.chainName;
      let igpUsdCost: number | null = null;
      let tokenFeeUsdCost: number | null = null;

      try {
        // Convert human-readable amount to smallest unit
        const amountWei = toWei(amount, token.decimals);
        const originTokenAmount = token.amount(amountWei);

        // Use protocol-appropriate placeholder addresses
        const senderAddress = PLACEHOLDER_ADDRESSES[token.protocol];
        const recipientAddress =
          PLACEHOLDER_ADDRESSES[connection.token.protocol];

        const { igpQuote, tokenFeeQuote } =
          await warpCore.getInterchainTransferFee({
            originTokenAmount,
            destination: destChain,
            sender: senderAddress,
            recipient: recipientAddress,
          });

        const igpFormatted = igpQuote.getDecimalFormattedAmount();
        let igpUsdStr = 'N/A';

        if (priceGetter) {
          try {
            const price = await priceGetter.getTokenPrice(
              igpQuote.token.chainName,
            );
            igpUsdCost = igpFormatted * price;
            igpUsdStr = `~$${igpUsdCost.toFixed(2)}`;
          } catch (e) {
            warnYellow(
              `Could not fetch USD price for ${igpQuote.token.chainName}: ${e}`,
            );
          }
        }

        // Calculate total USD (start with IGP)
        let totalUsd = igpUsdCost;

        // Handle token fee if present
        if (tokenFeeQuote) {
          const tokenFeeFormatted = tokenFeeQuote.getDecimalFormattedAmount();
          let tokenFeeUsdStr = 'N/A';

          if (priceGetter) {
            try {
              const tokenFeePrice = await priceGetter.getTokenPrice(
                tokenFeeQuote.token.chainName,
              );
              tokenFeeUsdCost = tokenFeeFormatted * tokenFeePrice;
              tokenFeeUsdStr = `~$${tokenFeeUsdCost.toFixed(2)}`;

              // Add to total
              if (totalUsd !== null) {
                totalUsd += tokenFeeUsdCost;
              } else {
                totalUsd = tokenFeeUsdCost;
              }
            } catch (e) {
              warnYellow(
                `Could not fetch USD price for ${tokenFeeQuote.token.chainName}: ${e}`,
              );
            }
          }

          // Add IGP row
          feeRows.push({
            Origin: token.chainName,
            Destination: destChain,
            'Fee Amount': igpFormatted.toFixed(8),
            'Fee Token': igpQuote.token.symbol,
            'USD Cost': igpUsdStr,
          });

          // Add token fee row
          feeRows.push({
            Origin: token.chainName,
            Destination: `${destChain} (token)`,
            'Fee Amount': tokenFeeFormatted.toFixed(8),
            'Fee Token': tokenFeeQuote.token.symbol,
            'USD Cost': tokenFeeUsdStr,
          });
        } else {
          // No token fee, just add IGP row
          feeRows.push({
            Origin: token.chainName,
            Destination: destChain,
            'Fee Amount': igpFormatted.toFixed(8),
            'Fee Token': igpQuote.token.symbol,
            'USD Cost': igpUsdStr,
          });
        }

        // Store total USD for matrix
        if (!totalUsdMatrix[token.chainName]) {
          totalUsdMatrix[token.chainName] = {};
        }
        totalUsdMatrix[token.chainName][destChain] =
          totalUsd !== null ? `$${totalUsd.toFixed(2)}` : 'N/A';
      } catch (e) {
        warnYellow(
          `Could not fetch fee for ${token.chainName} -> ${destChain}: ${e}`,
        );
        feeRows.push({
          Origin: token.chainName,
          Destination: destChain,
          'Fee Amount': 'Error',
          'Fee Token': '-',
          'USD Cost': 'N/A',
        });

        // Store error in matrix
        if (!totalUsdMatrix[token.chainName]) {
          totalUsdMatrix[token.chainName] = {};
        }
        totalUsdMatrix[token.chainName][destChain] = 'Error';
      }
    }
  }

  // Display results
  if (feeRows.length === 0) {
    logBlue('No routes found in warp config');
    return;
  }

  // Display detailed fee breakdown
  logBlue('\nFee Breakdown:');
  logTable(feeRows);

  // Build and display N x N matrix of total USD costs
  const chains = [...new Set(warpCore.tokens.map((t) => t.chainName))].sort();
  if (priceGetter && chains.length > 1) {
    logBlue('\nTotal USD Cost Matrix (From → To):');

    // Build matrix rows with chain name as first column
    const matrixRows: Record<string, string>[] = chains.map((fromChain) => {
      const row: Record<string, string> = { From: fromChain };
      for (const toChain of chains) {
        if (fromChain === toChain) {
          row[toChain] = '-';
        } else {
          row[toChain] = totalUsdMatrix[fromChain]?.[toChain] ?? 'N/A';
        }
      }
      return row;
    });

    logTable(matrixRows);
  }

  logGreen(`\nFees quoted for ${amount} token transfer.`);
  if (priceGetter) {
    logBlue('USD prices from CoinGecko (approximate).');
  }
}
