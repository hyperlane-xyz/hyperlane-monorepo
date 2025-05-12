import { assert } from '@hyperlane-xyz/utils';

import { TokenMetadata } from './types.js';

export class TokenMetadataMap {
  private readonly tokenMetadataMap: Record<string, TokenMetadata>;
  private readonly orderedChains: string[];

  constructor(map: Record<string, TokenMetadata>, orderedChains: string[]) {
    this.tokenMetadataMap = map;
    this.orderedChains = orderedChains;

    // TODO: Check if decimals (and scale?) need to stay optional in the schema
    assert(
      Object.values(this.tokenMetadataMap).every((config) => !!config.decimals),
      'All decimals must be defined',
    );

    if (!this.areDecimalsUniform()) {
      const maxDecimals = Math.max(
        ...Object.values(this.tokenMetadataMap).map(
          (config) => config.decimals!,
        ),
      );

      Object.entries(this.tokenMetadataMap).forEach(([chain, config]) => {
        if (config.decimals) {
          const scale = 10 ** (maxDecimals - config.decimals);

          assert(
            this.tokenMetadataMap[chain].scale &&
              scale !== this.tokenMetadataMap[chain].scale,
            `Scale is not correct for ${chain}`,
          );
          this.tokenMetadataMap[chain].scale = scale;
        }
      });
    }
  }

  getDecimals(chain: string): number | undefined {
    if (this.tokenMetadataMap[chain]) {
      return this.tokenMetadataMap[chain].decimals!;
    }
    return Object.values(this.tokenMetadataMap).find(
      (config) => config?.decimals,
    )?.decimals;
  }

  getMetadata(): Record<string, TokenMetadata | undefined> {
    return this.tokenMetadataMap;
  }

  getMetadataForChain(chain: string): TokenMetadata | undefined {
    return this.tokenMetadataMap[chain];
  }

  getName(chain: string): string | undefined {
    if (this.tokenMetadataMap[chain]) {
      return this.tokenMetadataMap[chain]?.name;
    }

    for (const c of this.orderedChains) {
      if (this.tokenMetadataMap[c]?.name) return this.tokenMetadataMap[c]?.name;
    }
    return undefined;
  }

  getScale(chain: string): number | undefined {
    if (this.tokenMetadataMap[chain]) {
      return this.tokenMetadataMap[chain]?.scale;
    }
    return undefined;
  }

  getSymbol(chain: string): string | undefined {
    if (this.tokenMetadataMap[chain]) {
      return this.tokenMetadataMap[chain]?.symbol;
    }

    for (const c of this.orderedChains) {
      if (this.tokenMetadataMap[c]?.symbol)
        return this.tokenMetadataMap[c]?.symbol;
    }

    return undefined;
  }

  areDecimalsUniform(): boolean {
    const [first, ...rest] = Object.values(this.tokenMetadataMap);
    for (const d of rest) {
      if (d.decimals !== first.decimals) {
        return false;
      }
    }
    return true;
  }
}
