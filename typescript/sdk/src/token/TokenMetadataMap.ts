import { assert } from '@hyperlane-xyz/utils';

import { TokenMetadata } from './types.js';

export class TokenMetadataMap {
  private readonly tokenMetadataMap: Record<string, TokenMetadata>;

  constructor(map: Record<string, TokenMetadata>) {
    this.tokenMetadataMap = map;

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
    // TODO: Make sure to sort this correctly to derive first priority
    return Object.values(this.tokenMetadataMap).find((config) => config?.name)
      ?.name;
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

    return Object.values(this.tokenMetadataMap).find((config) => config?.symbol)
      ?.symbol;
  }

  getFirstSymbol(): string | undefined {
    return Object.values(this.tokenMetadataMap).find((config) => config?.symbol)
      ?.symbol;
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
