import { AllDeprecatedChains } from '../consts/chains.js';
import { ChainMap, ChainName } from '../types.js';

// Generalized map container for chain name to some value
export class MultiGeneric<Value> {
  constructor(public readonly chainMap: ChainMap<Value>) {}

  /**
   * Get value for a chain
   * @throws if chain is invalid or has not been set
   */
  protected get(chain: ChainName): Value {
    const value = this.chainMap[chain] ?? null;
    if (!value) {
      throw new Error(`No chain value found for ${chain}`);
    }
    return value;
  }

  /**
   * Get value for a chain
   * @returns value or null if chain value has not been set
   */
  protected tryGet(chain: ChainName): Value | null {
    return this.chainMap[chain] ?? null;
  }

  /**
   * Set value for a chain
   * @throws if chain is invalid or has not been set
   */
  protected set(chain: ChainName, value: Value): Value {
    this.chainMap[chain] = value;
    return value;
  }

  chains(): ChainName[] {
    return Object.keys(this.chainMap).filter(
      (chain) => !AllDeprecatedChains.includes(chain),
    );
  }

  forEach(fn: (n: ChainName, dc: Value) => void): void {
    for (const chain of this.chains()) {
      fn(chain, this.chainMap[chain]);
    }
  }

  map<Output>(fn: (n: ChainName, dc: Value) => Output): ChainMap<Output> {
    const entries: [ChainName, Output][] = [];
    for (const chain of this.chains()) {
      entries.push([chain, fn(chain, this.chainMap[chain])]);
    }
    return Object.fromEntries(entries);
  }

  async remoteChains(name: ChainName): Promise<ChainName[]> {
    return this.chains().filter((key) => key !== name);
  }

  knownChain(chain: ChainName): boolean {
    return Object.keys(this.chainMap).includes(chain);
  }
}
