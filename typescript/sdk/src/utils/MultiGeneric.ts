import { ChainMap, ChainName, Remotes } from '../types';

export class MultiGeneric<Chain extends ChainName, Value> {
  constructor(public readonly chainMap: ChainMap<Chain, Value>) {}

  protected get(chain: Chain) {
    return this.chainMap[chain];
  }

  protected set(chain: Chain, value: Value) {
    this.chainMap[chain] = value;
  }

  chains = () => Object.keys(this.chainMap) as Chain[];

  apply(fn: (n: Chain, dc: Value) => void) {
    for (const chain of this.chains()) {
      fn(chain, this.chainMap[chain]);
    }
  }

  map<Output>(fn: (n: Chain, dc: Value) => Output) {
    const entries: [Chain, Output][] = [];
    const chains = this.chains();
    for (const chain of chains) {
      entries.push([chain, fn(chain, this.chainMap[chain])]);
    }
    return Object.fromEntries(entries) as Record<Chain, Output>;
  }

  remoteChains = <LocalChain extends Chain>(name: LocalChain) =>
    this.chains().filter((key) => key !== name) as Remotes<Chain, LocalChain>[];

  extendWithChain = <New extends Remotes<ChainName, Chain>>(
    chain: New,
    value: Value,
  ) =>
    new MultiGeneric<New & Chain, Value>({
      ...this.chainMap,
      [chain]: value,
    });

  knownChain = (chain: ChainName) => chain in this.chainMap;
}
