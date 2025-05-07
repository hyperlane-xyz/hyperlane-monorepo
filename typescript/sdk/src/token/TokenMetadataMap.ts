import { TokenMetadata } from './types.js';

export class TokenMetadataMap {
  private readonly metadata: Record<string, TokenMetadata | undefined>;

  constructor() {
    this.metadata = {};
  }

  getMetadata(): Record<string, TokenMetadata | undefined> {
    return this.metadata;
  }

  getMetadataForChain(chain: string): TokenMetadata | undefined {
    return this.metadata[chain];
  }

  getMetadataForChainSafe(chain: string): TokenMetadata {
    const metadata = this.metadata[chain];
    if (metadata) {
      return metadata;
    }

    const fallback = Object.values(this.metadata).find(
      (meta): meta is TokenMetadata => meta !== undefined,
    );

    if (!fallback) {
      throw new Error(
        `No TokenMetadata defined for any chain (including ${chain})`,
      );
    }

    return fallback;
  }

  getSymbol(): string | undefined {
    for (const config of Object.values(this.metadata)) {
      if (config && config.symbol) {
        return config.symbol;
      }
    }
    return undefined;
  }

  getName(): string | undefined {
    for (const config of Object.values(this.metadata)) {
      if (config && config.name) {
        return config.name;
      }
    }
    return undefined;
  }

  getDecimals(): number {
    const decimalsList = Object.values(this.metadata)
      .filter((config) => config && config.decimals !== undefined)
      .map((config) => config?.decimals);

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

  setMetadata(chain: string, metadata: TokenMetadata | undefined): void {
    this.metadata[chain] = metadata;
  }
}
