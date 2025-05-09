import { assert } from '@hyperlane-xyz/utils';

import { TokenMetadata } from './types.js';

export class TokenMetadataMap {
  private readonly tokenMetadataMap: Record<string, TokenMetadata>;

  constructor(map: Record<string, TokenMetadata>) {
    this.tokenMetadataMap = map;
  }

  getDecimals(): number {
    const decimalsList = Object.values(this.tokenMetadataMap)
      .filter(
        (config): config is TokenMetadata =>
          config !== undefined && config.decimals !== undefined,
      )
      .map((config) => config.decimals);

    assert(
      decimalsList.length,
      'No TokenMetadata or decimals defined for any chain',
    );

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

  getMetadata(): Record<string, TokenMetadata | undefined> {
    return this.tokenMetadataMap;
  }

  getMetadataForChain(chain: string): TokenMetadata | undefined {
    return this.tokenMetadataMap[chain];
  }

  getName(chain: string): string | undefined {
    if (this.tokenMetadataMap[chain]?.name) {
      return this.tokenMetadataMap[chain]?.name;
    }

    return Object.values(this.tokenMetadataMap).find((config) => config?.name)
      ?.name;
  }

  getSymbol(chain: string = ''): string | undefined {
    if (chain && this.tokenMetadataMap[chain]?.symbol) {
      return this.tokenMetadataMap[chain]?.symbol;
    }

    return Object.values(this.tokenMetadataMap).find((config) => config?.symbol)
      ?.symbol;
  }

  setMetadata(chain: string, metadata: TokenMetadata): void {
    this.tokenMetadataMap[chain] = metadata;
  }
}
