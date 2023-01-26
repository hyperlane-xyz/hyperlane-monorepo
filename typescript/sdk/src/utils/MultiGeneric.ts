import { AllDeprecatedChains } from '../consts/chains';
import { ChainMap, ChainName, Remotes } from '../types';

export class MultiGeneric<Chain extends ChainName, Value> {
  constructor(public readonly chainMap: ChainMap<Chain, Value>) {}

  /**
   * Get value for a chain
   * @throws if chain is invalid or has not been set
   */
  protected get(chain: Chain): Value {
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
  protected tryGet(chain: Chain): Value | null {
    return this.chainMap[chain] ?? null;
  }

  /**
   * Set value for a chain
   * @throws if chain is invalid or has not been set
   */
  protected set(chain: Chain, value: Value): Value {
    this.chainMap[chain] = value;
    return value;
  }

  chains(): Chain[] {
    return Object.keys(this.chainMap).filter(
      (chain) => !AllDeprecatedChains.includes(chain),
    ) as Chain[];
  }

  forEach(fn: (n: Chain, dc: Value) => void): void {
    for (const chain of this.chains()) {
      fn(chain, this.chainMap[chain]);
    }
  }

  map<Output>(fn: (n: Chain, dc: Value) => Output): Record<Chain, Output> {
    const entries: [Chain, Output][] = [];
    const chains = this.chains();
    for (const chain of chains) {
      entries.push([chain, fn(chain, this.chainMap[chain])]);
    }
    return Object.fromEntries(entries) as Record<Chain, Output>;
  }

  remoteChains<LocalChain extends Chain>(
    name: LocalChain,
  ): Remotes<Chain, LocalChain>[] {
    return this.chains().filter((key) => key !== name) as Remotes<
      Chain,
      LocalChain
    >[];
  }

  extendWithChain<New extends Remotes<ChainName, Chain>>(
    chain: New,
    value: Value,
  ): MultiGeneric<New & Chain, Value> {
    return new MultiGeneric<New & Chain, Value>({
      ...this.chainMap,
      [chain]: value,
    });
  }

  knownChain(chain: ChainName): boolean {
    return chain in this.chainMap;
  }
}
