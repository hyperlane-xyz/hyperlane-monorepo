import { TokenMetadata } from './types.js';

export type TokenMetadataMap = Record<string, TokenMetadata | undefined>;

export function getDecimals(map: TokenMetadataMap): number {
  const decimalsList = Object.values(map)
    .filter(
      (config): config is TokenMetadata =>
        config !== undefined && config.decimals !== undefined,
    )
    .map((config) => config.decimals);

  if (decimalsList.length === 0) {
    throw new Error(`No TokenMetadata or decimals defined for any chain`);
  }

  const [first, ...rest] = decimalsList;
  for (const d of rest) {
    if (d !== first) {
      throw new Error(
        `Mismatched decimals found in TokenMetadata: expected ${first}, but found ${d}`,
      );
    }
  }

  return first!;
}

export function getSymbol(
  map: TokenMetadataMap,
  chain: string = '',
): string | undefined {
  if (chain && map[chain]?.symbol) {
    return map[chain]?.symbol;
  }

  for (const config of Object.values(map)) {
    if (config?.symbol) {
      return config.symbol;
    }
  }
  return undefined;
}

export function getName(
  map: TokenMetadataMap,
  chain: string,
): string | undefined {
  if (map[chain]?.name) {
    return map[chain]?.name;
  }

  for (const config of Object.values(map)) {
    if (config?.name) {
      return config.name;
    }
  }
  return undefined;
}
