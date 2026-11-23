import { assert } from '@hyperlane-xyz/utils';

import type { Route } from '../interfaces/IStrategy.js';

import type { Delta } from './BaseStrategy.js';

interface Edge {
  destination: number;
  remaining: bigint;
  reverse?: Edge;
}

/** Allocate enabled routes, revisiting earlier choices when a donor has fewer exits. */
export function allocateRoutes(
  surpluses: Delta[],
  deficits: Delta[],
  enabled: (origin: string, destination: string) => boolean,
): Route[] {
  const source = 0;
  const sink = surpluses.length + deficits.length + 1;
  const graph: Edge[][] = Array.from({ length: sink + 1 }, () => []);
  const routes: {
    origin: string;
    destination: string;
    capacity: bigint;
    edge: Edge;
  }[] = [];
  const addEdge = (from: number, to: number, capacity: bigint): Edge => {
    const forward: Edge = { destination: to, remaining: capacity };
    const reverse: Edge = {
      destination: from,
      remaining: 0n,
      reverse: forward,
    };
    forward.reverse = reverse;
    graph[from].push(forward);
    graph[to].push(reverse);
    return forward;
  };

  for (const [i, surplus] of surpluses.entries()) {
    addEdge(source, i + 1, surplus.amount);
    for (const [j, deficit] of deficits.entries()) {
      if (!enabled(surplus.chain, deficit.chain)) continue;
      const capacity =
        surplus.amount < deficit.amount ? surplus.amount : deficit.amount;
      const edge = addEdge(i + 1, surpluses.length + j + 1, capacity);
      routes.push({
        origin: surplus.chain,
        destination: deficit.chain,
        capacity,
        edge,
      });
    }
  }
  for (const [j, deficit] of deficits.entries()) {
    addEdge(surpluses.length + j + 1, sink, deficit.amount);
  }

  // Residual backward edges let a later donor reclaim a recipient served earlier.
  for (;;) {
    const parents = new Map<number, { from: number; edge: Edge }>();
    const visited = new Set([source]);
    const queue = [source];
    for (let index = 0; index < queue.length && !visited.has(sink); index++) {
      const from = queue[index];
      for (const edge of graph[from]) {
        if (edge.remaining <= 0n || visited.has(edge.destination)) continue;
        visited.add(edge.destination);
        parents.set(edge.destination, { from, edge });
        queue.push(edge.destination);
      }
    }
    if (!visited.has(sink)) break;

    let amount: bigint | undefined;
    for (let node = sink; node !== source;) {
      const step = parents.get(node);
      assert(step, 'Missing allocation path');
      amount =
        amount === undefined || step.edge.remaining < amount
          ? step.edge.remaining
          : amount;
      node = step.from;
    }
    assert(amount !== undefined && amount > 0n, 'Empty allocation path');
    for (let node = sink; node !== source;) {
      const step = parents.get(node);
      assert(step?.edge.reverse, 'Missing reverse allocation edge');
      step.edge.remaining -= amount;
      step.edge.reverse.remaining += amount;
      node = step.from;
    }
  }

  return routes.flatMap(({ origin, destination, capacity, edge }) => {
    const amount = capacity - edge.remaining;
    return amount > 0n ? [{ origin, destination, amount }] : [];
  });
}
