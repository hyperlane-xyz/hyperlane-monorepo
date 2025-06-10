import { assert } from '@hyperlane-xyz/utils';

import { verifyScale } from '../utils/decimals.js';

import { TokenMetadata } from './types.js';

export class TokenMetadataMap {
  private readonly tokenMetadataMap: Map<string, TokenMetadata>;

  constructor() {
    this.tokenMetadataMap = new Map();
  }

  set(chain: string, metadata: TokenMetadata): void {
    this.tokenMetadataMap.set(chain, metadata);
  }

  getDecimals(chain: string): number | undefined {
    const config = this.tokenMetadataMap.get(chain);
    if (config) return config.decimals!;
    return [...this.tokenMetadataMap.values()].find(
      (config) => config?.decimals,
    )?.decimals;
  }

  getMetadataForChain(chain: string): TokenMetadata | undefined {
    return this.tokenMetadataMap.get(chain);
  }

  getName(chain: string): string | undefined {
    const config = this.tokenMetadataMap.get(chain);
    if (config?.name) return config.name;

    for (const [, meta] of this.tokenMetadataMap) {
      if (meta.name) return meta.name;
    }
    return undefined;
  }

  getScale(chain: string): number | undefined {
    return this.tokenMetadataMap.get(chain)?.scale;
  }

  getSymbol(chain: string): string {
    const symbol = this.tokenMetadataMap.get(chain)?.symbol;
    if (symbol) return symbol;

    return this.getDefaultSymbol();
  }

  getDefaultSymbol(): string {
    for (const [, metadata] of this.tokenMetadataMap) {
      if (metadata.symbol) return metadata.symbol;
    }
    throw new Error('No symbol found in token metadata map.');
  }

  finalize(): void {
    assert(
      [...this.tokenMetadataMap.values()].every((config) => !!config.decimals),
      'All decimals must be defined',
    );

    assert(
      verifyScale(this.tokenMetadataMap),
      `Found invalid or missing scale for inconsistent decimals`,
    );
  }
}
