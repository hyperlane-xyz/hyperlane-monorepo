import { Address, assert, normalizeAddressEvm } from '@hyperlane-xyz/utils';

import { ChainName } from '../types.js';
import {
  NormalizedScale,
  ScaleInput,
  normalizeScale,
} from '../utils/decimals.js';

export type CrossCollateralRouterReference = {
  chainName: ChainName;
  routerAddress: Address;
};

export type CrossCollateralValidationNode = CrossCollateralRouterReference & {
  decimals: number;
  peers: CrossCollateralRouterReference[];
  scale?: ScaleInput;
  symbol: string;
};

export type CrossCollateralValidationNodeLoader = (
  ref: CrossCollateralRouterReference,
) => Promise<CrossCollateralValidationNode>;

export function getCrossCollateralRouterId(
  ref: CrossCollateralRouterReference,
): string {
  return `${ref.chainName}:${normalizeAddressEvm(ref.routerAddress)}`;
}

export function formatCrossCollateralScaleForLogs(
  scale: ScaleInput | undefined,
): string {
  const normalizedScale = normalizeScale(scale);
  if (normalizedScale.denominator === 1n) {
    return normalizedScale.numerator.toString();
  }
  return `${normalizedScale.numerator}/${normalizedScale.denominator}`;
}

export function getMessageAmountTokenScale({
  decimals,
  scale,
}: {
  decimals: number;
  scale?: ScaleInput;
}): NormalizedScale {
  const normalizedScale = normalizeScale(scale);
  return {
    numerator: 10n ** BigInt(decimals) * normalizedScale.numerator,
    denominator: normalizedScale.denominator,
  };
}

export async function validateCrossCollateralGraph({
  roots,
  loadNode,
  describeRef,
}: {
  roots: CrossCollateralRouterReference[];
  loadNode: CrossCollateralValidationNodeLoader;
  describeRef?: (ref: CrossCollateralRouterReference) => string;
}): Promise<void> {
  if (roots.length === 0) {
    return;
  }

  const visited = new Set<string>();
  const getNode = getCachedCrossCollateralNodeLoader(loadNode);
  const describe = describeRef ?? describeCrossCollateralRouterRef;

  for (const root of dedupeCrossCollateralRouterRefs(roots)) {
    const rootRouterId = getCrossCollateralRouterId(root);
    if (visited.has(rootRouterId)) {
      continue;
    }
    const componentNodes = await collectCrossCollateralComponent({
      root,
      getNode,
      visited,
    });
    assertConsistentCrossCollateralComponent(componentNodes, describe);
  }
}

function assertConsistentCrossCollateralComponent(
  nodes: CrossCollateralValidationNode[],
  describeRef: (ref: CrossCollateralRouterReference) => string,
) {
  if (nodes.length <= 1) {
    return;
  }

  const [baseNode, ...candidateNodes] = nodes;
  const baseMessageAmountTokenScale = getMessageAmountTokenScale(baseNode);

  for (const candidateNode of candidateNodes) {
    const candidateMessageAmountTokenScale =
      getMessageAmountTokenScale(candidateNode);
    const isCompatible =
      baseMessageAmountTokenScale.numerator *
        candidateMessageAmountTokenScale.denominator ===
      candidateMessageAmountTokenScale.numerator *
        baseMessageAmountTokenScale.denominator;

    assert(
      isCompatible,
      `Incompatible CrossCollateralRouter decimals/scale between ${describeRef(baseNode)} ` +
        `(${baseNode.symbol}, decimals=${baseNode.decimals}, scale=${formatCrossCollateralScaleForLogs(baseNode.scale)}) ` +
        `and ${describeRef(candidateNode)} ` +
        `(${candidateNode.symbol}, decimals=${candidateNode.decimals}, scale=${formatCrossCollateralScaleForLogs(candidateNode.scale)}).`,
    );
  }
}

function describeCrossCollateralRouterRef(
  ref: CrossCollateralRouterReference,
): string {
  return `"${ref.chainName}:${normalizeAddressEvm(ref.routerAddress)}"`;
}

function getCachedCrossCollateralNodeLoader(
  loadNode: CrossCollateralValidationNodeLoader,
): CrossCollateralValidationNodeLoader {
  const nodePromises = new Map<
    string,
    Promise<CrossCollateralValidationNode>
  >();

  return (ref) => {
    const routerId = getCrossCollateralRouterId(ref);
    const existing = nodePromises.get(routerId);
    if (existing) {
      return existing;
    }

    const next = loadNode(ref);
    nodePromises.set(routerId, next);
    return next;
  };
}

async function collectCrossCollateralComponent({
  root,
  getNode,
  visited,
}: {
  root: CrossCollateralRouterReference;
  getNode: CrossCollateralValidationNodeLoader;
  visited: Set<string>;
}): Promise<CrossCollateralValidationNode[]> {
  const componentNodes: CrossCollateralValidationNode[] = [];
  const componentQueue = [root];

  while (componentQueue.length > 0) {
    const ref = componentQueue.shift()!;
    const routerId = getCrossCollateralRouterId(ref);
    if (visited.has(routerId)) {
      continue;
    }
    visited.add(routerId);

    const node = await getNode(ref);
    componentNodes.push(node);

    for (const peer of dedupeCrossCollateralRouterRefs(node.peers)) {
      if (!visited.has(getCrossCollateralRouterId(peer))) {
        componentQueue.push(peer);
      }
    }
  }

  return componentNodes;
}

export function dedupeCrossCollateralRouterRefs(
  refs: CrossCollateralRouterReference[],
): CrossCollateralRouterReference[] {
  const deduped = new Map<string, CrossCollateralRouterReference>();
  for (const ref of refs) {
    deduped.set(getCrossCollateralRouterId(ref), {
      chainName: ref.chainName,
      routerAddress: normalizeAddressEvm(ref.routerAddress),
    });
  }
  return [...deduped.values()];
}
