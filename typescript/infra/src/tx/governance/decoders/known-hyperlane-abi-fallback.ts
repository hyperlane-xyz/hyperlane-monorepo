import { BigNumber, ethers } from 'ethers';

import {
  CrossCollateralRouter__factory,
  CrossCollateralRoutingFee__factory,
  DomainRoutingHook__factory,
  DomainRoutingIsm__factory,
  MovableCollateralRouter__factory,
  TokenBridgeDepositAddress__factory,
  TokenBridgeOft__factory,
} from '@hyperlane-xyz/core';

import type { GovernTransaction, GovernanceDecoder } from '../types.js';
import { formatDomain, matchesFunctionSignature } from '../utils.js';

export function createKnownHyperlaneAbiFallbackDecoder(): GovernanceDecoder<GovernTransaction> {
  return {
    id: 'known-hyperlane-abi-fallback',
    priority: 120,
    match: ({ state, chain, tx }) =>
      tryReadByKnownContractInterface(
        (domain) => state.multiProvider.tryGetChainName(domain) ?? undefined,
        chain,
        tx,
      ),
    decode: async ({ match }) => match,
  };
}

function tryReadByKnownContractInterface(
  getChainName: (domain: number) => string | undefined,
  chain: string,
  tx: Parameters<GovernanceDecoder['decode']>[0]['tx'],
): GovernTransaction | undefined {
  if (!tx.data || tx.data.length < 10 || !tx.to) return undefined;

  const tryParse = (iface: ethers.utils.Interface) => {
    try {
      return iface.parseTransaction({ data: tx.data!, value: tx.value });
    } catch {
      return undefined;
    }
  };

  const formatBase = (
    contractType: string,
    decoded: ethers.utils.TransactionDescription,
    insight: string,
  ) => ({
    chain,
    to: `${contractType} (${chain} ${tx.to})`,
    insight,
    signature: decoded.signature,
    decoderMatch: {
      confidence: 'selector-only',
      insight: 'unverified ABI match',
    },
  });

  const ccrIface = CrossCollateralRouter__factory.createInterface();
  const movableIface = MovableCollateralRouter__factory.createInterface();
  const ccrDecoded = tryParse(ccrIface) ?? tryParse(movableIface);
  if (ccrDecoded) {
    const insight = formatRouterCallInsight(
      getChainName,
      ccrIface,
      movableIface,
      ccrDecoded,
    );
    return formatBase('Warp Route (unregistered)', ccrDecoded, insight);
  }

  const oftIface = TokenBridgeOft__factory.createInterface();
  const oftDecoded = tryParse(oftIface);
  if (oftDecoded) {
    const insight = formatTokenBridgeOftInsight(
      getChainName,
      oftIface,
      oftDecoded,
    );
    return formatBase('TokenBridgeOft', oftDecoded, insight);
  }

  const depositAddrIface = TokenBridgeDepositAddress__factory.createInterface();
  const depositAddrDecoded = tryParse(depositAddrIface);
  if (depositAddrDecoded) {
    const insight = formatTokenBridgeDepositAddressInsight(
      getChainName,
      depositAddrIface,
      depositAddrDecoded,
    );
    return formatBase('TokenBridgeDepositAddress', depositAddrDecoded, insight);
  }

  const ccrFeeIface = CrossCollateralRoutingFee__factory.createInterface();
  const ccrFeeDecoded = tryParse(ccrFeeIface);
  if (ccrFeeDecoded) {
    const insight = formatCrossCollateralRoutingFeeInsight(
      getChainName,
      ccrFeeIface,
      ccrFeeDecoded,
    );
    return formatBase('CrossCollateralRoutingFee', ccrFeeDecoded, insight);
  }

  const routingHookIface = DomainRoutingHook__factory.createInterface();
  const routingHookDecoded = tryParse(routingHookIface);
  if (routingHookDecoded) {
    const insight = formatDomainRoutingHookInsight(
      getChainName,
      routingHookIface,
      routingHookDecoded,
    );
    return formatBase('DomainRoutingHook', routingHookDecoded, insight);
  }

  const routingIsmIface = DomainRoutingIsm__factory.createInterface();
  const routingIsmDecoded = tryParse(routingIsmIface);
  if (routingIsmDecoded) {
    const insight = formatDomainRoutingIsmInsight(
      getChainName,
      routingIsmIface,
      routingIsmDecoded,
    );
    return formatBase('DomainRoutingIsm', routingIsmDecoded, insight);
  }

  return undefined;
}

function formatRouterCallInsight(
  getChainName: (domain: number) => string | undefined,
  ccrIface: ethers.utils.Interface,
  movableIface: ethers.utils.Interface,
  decoded: ethers.utils.TransactionDescription,
): string {
  const args = decoded.args;
  const fmt = (domain: number | BigNumber) =>
    formatDomain(getChainName, domain);

  if (
    matchesFunctionSignature(decoded, movableIface, 'addBridge(uint32,address)')
  ) {
    return `Set bridge for origin domain ${fmt(args[0])} to ${args[1]}`;
  }
  if (
    matchesFunctionSignature(
      decoded,
      movableIface,
      'removeBridge(uint32,address)',
    )
  ) {
    return `Remove bridge ${args[1]} from domain ${fmt(args[0])}`;
  }
  if (
    matchesFunctionSignature(
      decoded,
      movableIface,
      'enrollRemoteRouter(uint32,bytes32)',
    )
  ) {
    return `Enroll remote router for domain ${fmt(args[0])} to ${args[1]}`;
  }
  if (
    matchesFunctionSignature(
      decoded,
      movableIface,
      'enrollRemoteRouters(uint32[],bytes32[])',
    )
  ) {
    const [domains, routers] = args;
    const lines = domains.map(
      (d: number, i: number) => `domain ${fmt(d)} to ${routers[i]}`,
    );
    return `Enroll remote routers for ${lines.join(', ')}`;
  }
  if (
    matchesFunctionSignature(
      decoded,
      movableIface,
      'unenrollRemoteRouter(uint32)',
    )
  ) {
    return `Unenroll remote router for domain ${fmt(args[0])}`;
  }
  if (
    matchesFunctionSignature(
      decoded,
      movableIface,
      'unenrollRemoteRouters(uint32[])',
    )
  ) {
    const lines = args[0].map((d: number) => `domain ${fmt(d)}`);
    return `Unenroll remote routers for ${lines.join(', ')}`;
  }
  if (
    matchesFunctionSignature(
      decoded,
      movableIface,
      'setDestinationGas((uint32,uint256)[])',
    )
  ) {
    const lines = args[0].map(
      (c: { domain: number; gas: BigNumber }) =>
        `domain ${fmt(c.domain)} to ${c.gas.toString()}`,
    );
    return `Set destination gas for ${lines.join(', ')}`;
  }
  if (
    matchesFunctionSignature(
      decoded,
      movableIface,
      'setDestinationGas(uint32,uint256)',
    )
  ) {
    return `Set destination gas for domain ${fmt(args[0])} to ${args[1].toString()}`;
  }
  if (matchesFunctionSignature(decoded, movableIface, 'setHook(address)')) {
    return `Set hook to ${args[0]}`;
  }
  if (
    matchesFunctionSignature(
      decoded,
      movableIface,
      'setInterchainSecurityModule(address)',
    )
  ) {
    return `Set ISM to ${args[0]}`;
  }
  if (
    matchesFunctionSignature(decoded, movableIface, 'setFeeRecipient(address)')
  ) {
    return `Set fee recipient to ${args[0]}`;
  }
  if (
    matchesFunctionSignature(decoded, movableIface, 'addRebalancer(address)')
  ) {
    return `Add rebalancer ${args[0]}`;
  }
  if (
    matchesFunctionSignature(decoded, movableIface, 'removeRebalancer(address)')
  ) {
    return `Remove rebalancer ${args[0]}`;
  }
  if (
    matchesFunctionSignature(
      decoded,
      movableIface,
      'setRecipient(uint32,bytes32)',
    )
  ) {
    return `Set rebalance recipient for domain ${fmt(args[0])} to ${args[1]}`;
  }
  if (
    matchesFunctionSignature(decoded, movableIface, 'removeRecipient(uint32)')
  ) {
    return `Remove rebalance recipient for domain ${fmt(args[0])}`;
  }
  if (
    matchesFunctionSignature(
      decoded,
      movableIface,
      'approveTokenForBridge(address,address)',
    )
  ) {
    return `Approve token ${args[0]} for bridge ${args[1]}`;
  }
  if (
    matchesFunctionSignature(
      decoded,
      ccrIface,
      'enrollCrossCollateralRouters(uint32[],bytes32[])',
    )
  ) {
    const [domains, routers] = args;
    const lines = domains.map(
      (d: number, i: number) => `domain ${fmt(d)} to ${routers[i]}`,
    );
    return `Enroll cross-collateral routers for ${lines.join(', ')}`;
  }
  if (
    matchesFunctionSignature(
      decoded,
      ccrIface,
      'unenrollCrossCollateralRouters(uint32[],bytes32[])',
    )
  ) {
    const [domains, routers] = args;
    const lines = domains.map(
      (d: number, i: number) => `domain ${fmt(d)} from ${routers[i]}`,
    );
    return `Unenroll cross-collateral routers for ${lines.join(', ')}`;
  }
  return `Call ${decoded.signature}`;
}

function formatTokenBridgeOftInsight(
  getChainName: (domain: number) => string | undefined,
  iface: ethers.utils.Interface,
  decoded: ethers.utils.TransactionDescription,
): string {
  const args = decoded.args;
  const fmt = (domain: number | BigNumber) =>
    formatDomain(getChainName, domain);
  if (matchesFunctionSignature(decoded, iface, 'addDomain(uint32,uint32)')) {
    return `Map Hyperlane domain ${fmt(args[0])} to LayerZero EID ${args[1]}`;
  }
  if (matchesFunctionSignature(decoded, iface, 'removeDomain(uint32)')) {
    return `Remove Hyperlane domain ${fmt(args[0])} mapping`;
  }
  if (matchesFunctionSignature(decoded, iface, 'setExtraOptions(bytes)')) {
    return `Set extra LayerZero options`;
  }
  return `Call ${decoded.signature}`;
}

function formatTokenBridgeDepositAddressInsight(
  getChainName: (domain: number) => string | undefined,
  iface: ethers.utils.Interface,
  decoded: ethers.utils.TransactionDescription,
): string {
  const args = decoded.args;
  const fmt = (domain: number | BigNumber) =>
    formatDomain(getChainName, domain);
  if (
    matchesFunctionSignature(
      decoded,
      iface,
      'addDestinationConfig(uint32,address,bytes32,uint256)',
    )
  ) {
    return `Add destination config: domain ${fmt(args[0])}, depositAddress ${args[1]}, recipient ${args[2]}, feeBps ${args[3].toString()}`;
  }
  if (
    matchesFunctionSignature(
      decoded,
      iface,
      'removeDestinationConfig(uint32,bytes32)',
    )
  ) {
    return `Remove destination config: domain ${fmt(args[0])}, recipient ${args[1]}`;
  }
  return `Call ${decoded.signature}`;
}

function formatCrossCollateralRoutingFeeInsight(
  getChainName: (domain: number) => string | undefined,
  iface: ethers.utils.Interface,
  decoded: ethers.utils.TransactionDescription,
): string {
  const args = decoded.args;
  const fmt = (domain: number | BigNumber) =>
    formatDomain(getChainName, domain);
  if (
    matchesFunctionSignature(
      decoded,
      iface,
      'setCrossCollateralRouterFeeContracts(uint32[],bytes32[],address[])',
    )
  ) {
    const [destinations, targetRouters, feeContracts] = args;
    const lines = destinations.map(
      (d: number, i: number) =>
        `domain ${fmt(d)} router ${targetRouters[i]} → fee ${feeContracts[i]}`,
    );
    return `Set per-router fee contracts: ${lines.join(', ')}`;
  }
  if (matchesFunctionSignature(decoded, iface, 'claim(address,address)')) {
    return `Claim ${args[1]} balance to ${args[0]}`;
  }
  return `Call ${decoded.signature}`;
}

function formatDomainRoutingHookInsight(
  getChainName: (domain: number) => string | undefined,
  iface: ethers.utils.Interface,
  decoded: ethers.utils.TransactionDescription,
): string {
  const args = decoded.args;
  const fmt = (domain: number | BigNumber) =>
    formatDomain(getChainName, domain);
  if (matchesFunctionSignature(decoded, iface, 'setHook(uint32,address)')) {
    return `Set hook for destination ${fmt(args[0])} to ${args[1]}`;
  }
  if (matchesFunctionSignature(decoded, iface, 'setHook(address)')) {
    return `Set mailbox client hook to ${args[0]}`;
  }
  if (
    matchesFunctionSignature(decoded, iface, 'setHooks((uint32,address)[])')
  ) {
    const lines = args[0].map(
      (cfg: { destination: number; hook: string }) =>
        `destination ${fmt(cfg.destination)} → ${cfg.hook}`,
    );
    return `Set hooks: ${lines.join(', ')}`;
  }
  return `Call ${decoded.signature}`;
}

function formatDomainRoutingIsmInsight(
  getChainName: (domain: number) => string | undefined,
  iface: ethers.utils.Interface,
  decoded: ethers.utils.TransactionDescription,
): string {
  const args = decoded.args;
  const fmt = (domain: number | BigNumber) =>
    formatDomain(getChainName, domain);
  if (matchesFunctionSignature(decoded, iface, 'set(uint32,address)')) {
    return `Set ISM for origin ${fmt(args[0])} to ${args[1]}`;
  }
  if (matchesFunctionSignature(decoded, iface, 'remove(uint32)')) {
    return `Remove ISM for origin ${fmt(args[0])}`;
  }
  return `Call ${decoded.signature}`;
}
