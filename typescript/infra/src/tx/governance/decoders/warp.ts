import assert from 'assert';
import { BigNumber, ethers } from 'ethers';

import {
  CrossCollateralRouter__factory,
  MovableCollateralRouter__factory,
  TokenBridgeCctpV2__factory,
  TokenBridgeDepositAddress__factory,
  TokenBridgeOft__factory,
} from '@hyperlane-xyz/core';

import { readFeeContractDetails } from '../fees.js';
import type { GovernanceDecoder } from '../types.js';
import { formatDomain, matchesFunctionSignature } from '../utils.js';

export function createWarpModuleDecoder(): GovernanceDecoder {
  return {
    id: 'warp-module',
    priority: 80,
    match: ({ state, chain, tx }) =>
      tx.to !== undefined &&
      state.warpRouteIndex[chain] !== undefined &&
      state.warpRouteIndex[chain][tx.to.toLowerCase()] !== undefined
        ? true
        : undefined,
    decode: async ({ runtime, state, chain, tx }) => {
      if (!tx.data) {
        throw new Error('No data in Warp Module transaction');
      }

      const { symbol } = await state.multiProvider.getNativeToken(chain);
      const tokenRouterInterface =
        MovableCollateralRouter__factory.createInterface();
      const ccrInterface = CrossCollateralRouter__factory.createInterface();
      const cctpV2Interface = TokenBridgeCctpV2__factory.createInterface();
      const oftInterface = TokenBridgeOft__factory.createInterface();
      const depositAddrInterface =
        TokenBridgeDepositAddress__factory.createInterface();

      const parseAttempts: Array<() => ethers.utils.TransactionDescription> = [
        () =>
          tokenRouterInterface.parseTransaction({
            data: tx.data!,
            value: tx.value,
          }),
        () =>
          ccrInterface.parseTransaction({ data: tx.data!, value: tx.value }),
        () =>
          cctpV2Interface.parseTransaction({
            data: tx.data!,
            value: tx.value,
          }),
        () =>
          oftInterface.parseTransaction({ data: tx.data!, value: tx.value }),
        () =>
          depositAddrInterface.parseTransaction({
            data: tx.data!,
            value: tx.value,
          }),
      ];
      let decoded: ethers.utils.TransactionDescription | undefined;
      let lastError: unknown;
      for (const attempt of parseAttempts) {
        try {
          decoded = attempt();
          break;
        } catch (err) {
          lastError = err;
        }
      }
      if (!decoded) {
        throw lastError;
      }

      let insight: string | undefined;
      let feeDetails: Record<string, unknown> | undefined;
      if (
        decoded.functionFragment.name ===
        tokenRouterInterface.functions['setHook(address)'].name
      ) {
        const [hookAddress] = decoded.args;
        insight = `Set hook to ${hookAddress}`;
      }

      if (
        decoded.functionFragment.name ===
        tokenRouterInterface.functions['addBridge(uint32,address)'].name
      ) {
        const [domain, bridgeAddress] = decoded.args;
        insight = `Set bridge for origin domain ${domain} to ${bridgeAddress}`;
      }

      if (
        decoded.functionFragment.name ===
        tokenRouterInterface.functions['removeBridge(uint32,address)'].name
      ) {
        const [domain, bridgeAddress] = decoded.args;
        const chainName = state.multiProvider.tryGetChainName(domain);
        insight = `Remove bridge ${bridgeAddress} from domain ${domain}${chainName ? ` (${chainName})` : ''}`;
      }

      if (
        decoded.functionFragment.name ===
        tokenRouterInterface.functions['addRebalancer(address)'].name
      ) {
        const [rebalancer] = decoded.args;
        insight = `Add rebalancer ${rebalancer}`;
      }

      if (
        decoded.functionFragment.name ===
        tokenRouterInterface.functions['setInterchainSecurityModule(address)']
          .name
      ) {
        const [ismAddress] = decoded.args;
        insight = `Set ISM to ${ismAddress}`;
      }

      if (
        matchesFunctionSignature(
          decoded,
          tokenRouterInterface,
          'setDestinationGas((uint32,uint256)[])',
        )
      ) {
        const [gasConfigs] = decoded.args;
        const insights = gasConfigs.map(
          (config: { domain: number; gas: BigNumber }) => {
            return `domain ${formatDomain(
              (domain) => state.multiProvider.tryGetChainName(domain),
              config.domain,
            )} to ${config.gas.toString()}`;
          },
        );
        insight = `Set destination gas for ${insights.join(', ')}`;
      }

      if (
        matchesFunctionSignature(
          decoded,
          tokenRouterInterface,
          'setDestinationGas(uint32,uint256)',
        )
      ) {
        const [domain, gas] = decoded.args;
        insight = `Set destination gas for domain ${formatDomain(
          (domainNumber) => state.multiProvider.tryGetChainName(domainNumber),
          domain,
        )} to ${gas.toString()}`;
      }

      if (
        decoded.functionFragment.name ===
        tokenRouterInterface.functions[
          'enrollRemoteRouters(uint32[],bytes32[])'
        ].name
      ) {
        const [domains, routers] = decoded.args;
        const insights = domains.map((domain: number, index: number) => {
          const chainName = state.multiProvider.getChainName(domain);
          return `domain ${domain} (${chainName}) to ${routers[index]}`;
        });
        insight = `Enroll remote routers for ${insights.join(', ')}`;
      }

      if (
        decoded.functionFragment.name ===
        tokenRouterInterface.functions['unenrollRemoteRouter(uint32)'].name
      ) {
        const [domain] = decoded.args;
        const chainName = state.multiProvider.getChainName(domain);
        insight = `Unenroll remote router for domain ${domain} (${chainName})`;
      }

      if (
        decoded.functionFragment.name ===
        tokenRouterInterface.functions['unenrollRemoteRouters(uint32[])'].name
      ) {
        const [domains] = decoded.args;
        const insights = domains.map((domain: number) => {
          const chainName = state.multiProvider.getChainName(domain);
          return `domain ${domain} (${chainName})`;
        });
        insight = `Unenroll remote routers for ${insights.join(', ')}`;
      }

      if (
        decoded.functionFragment.name ===
        tokenRouterInterface.functions['setFeeRecipient(address)'].name
      ) {
        const [recipient] = decoded.args;
        const feeInfo = await readFeeContractDetails(
          state.multiProvider,
          chain,
          tx.to!,
          recipient,
        );
        insight = feeInfo.insight;
        feeDetails = feeInfo.feeDetails;
      }

      if (
        decoded.functionFragment.name ===
        tokenRouterInterface.functions['removeRebalancer(address)'].name
      ) {
        const [rebalancer] = decoded.args;
        insight = `Remove rebalancer ${rebalancer}`;
      }

      if (
        decoded.functionFragment.name ===
        tokenRouterInterface.functions['setRecipient(uint32,bytes32)'].name
      ) {
        const [domain, recipient] = decoded.args;
        const chainName = state.multiProvider.tryGetChainName(domain);
        insight = `Set rebalance recipient for domain ${domain}${chainName ? ` (${chainName})` : ''} to ${recipient}`;
      }

      if (
        decoded.functionFragment.name ===
        tokenRouterInterface.functions['removeRecipient(uint32)'].name
      ) {
        const [domain] = decoded.args;
        const chainName = state.multiProvider.tryGetChainName(domain);
        insight = `Remove rebalance recipient for domain ${domain}${chainName ? ` (${chainName})` : ''}`;
      }

      if (
        decoded.functionFragment.name ===
        tokenRouterInterface.functions['approveTokenForBridge(address,address)']
          .name
      ) {
        const [token, bridge] = decoded.args;
        insight = `Approve token ${token} for bridge ${bridge}`;
      }

      if (
        decoded.functionFragment.name ===
        tokenRouterInterface.functions['enrollRemoteRouter(uint32,bytes32)']
          .name
      ) {
        const [domain, router] = decoded.args;
        const chainName = state.multiProvider.tryGetChainName(domain);
        insight = `Enroll remote router for domain ${domain}${chainName ? ` (${chainName})` : ''} to ${router}`;
      }

      if (
        matchesFunctionSignature(
          decoded,
          cctpV2Interface,
          'setMaxFeePpm(uint256)',
        )
      ) {
        const [maxFeePpm] = decoded.args;
        const bps = BigNumber.from(maxFeePpm).toNumber() / 100;
        insight = `Set max fee to ${maxFeePpm} ppm (${bps} bps)`;
      }

      if (
        matchesFunctionSignature(
          decoded,
          ccrInterface,
          'enrollCrossCollateralRouters(uint32[],bytes32[])',
        )
      ) {
        const [domains, routers] = decoded.args;
        const insights = domains.map((domain: number, index: number) => {
          const chainName = state.multiProvider.tryGetChainName(domain);
          return `domain ${domain}${chainName ? ` (${chainName})` : ''} to ${routers[index]}`;
        });
        insight = `Enroll cross-collateral routers for ${insights.join(', ')}`;
      }

      if (
        matchesFunctionSignature(
          decoded,
          ccrInterface,
          'unenrollCrossCollateralRouters(uint32[],bytes32[])',
        )
      ) {
        const [domains, routers] = decoded.args;
        const insights = domains.map((domain: number, index: number) => {
          const chainName = state.multiProvider.tryGetChainName(domain);
          return `domain ${domain}${chainName ? ` (${chainName})` : ''} from ${routers[index]}`;
        });
        insight = `Unenroll cross-collateral routers for ${insights.join(', ')}`;
      }

      if (
        matchesFunctionSignature(
          decoded,
          oftInterface,
          'addDomain(uint32,uint32)',
        )
      ) {
        const [hypDomain, lzEid] = decoded.args;
        const chainName = state.multiProvider.tryGetChainName(hypDomain);
        insight = `Map Hyperlane domain ${hypDomain}${chainName ? ` (${chainName})` : ''} to LayerZero EID ${lzEid}`;
      }

      if (
        matchesFunctionSignature(decoded, oftInterface, 'removeDomain(uint32)')
      ) {
        const [hypDomain] = decoded.args;
        const chainName = state.multiProvider.tryGetChainName(hypDomain);
        insight = `Remove Hyperlane domain ${hypDomain}${chainName ? ` (${chainName})` : ''} mapping`;
      }

      if (
        matchesFunctionSignature(
          decoded,
          oftInterface,
          'setExtraOptions(bytes)',
        )
      ) {
        const [options] = decoded.args;
        insight = `Set LayerZero extraOptions to ${options}`;
      }

      if (
        matchesFunctionSignature(
          decoded,
          depositAddrInterface,
          'addDestinationConfig(uint32,address,bytes32,uint256)',
        )
      ) {
        const [destination, depositAddress, recipient, feeBps] = decoded.args;
        const chainName = state.multiProvider.tryGetChainName(destination);
        insight = `Add destination config: domain ${destination}${chainName ? ` (${chainName})` : ''}, depositAddress ${depositAddress}, recipient ${recipient}, feeBps ${feeBps.toString()}`;
      }

      if (
        matchesFunctionSignature(
          decoded,
          depositAddrInterface,
          'removeDestinationConfig(uint32,bytes32)',
        )
      ) {
        const [destination, recipient] = decoded.args;
        const chainName = state.multiProvider.tryGetChainName(destination);
        insight = `Remove destination config: domain ${destination}${chainName ? ` (${chainName})` : ''}, recipient ${recipient}`;
      }

      let ownableTx = {};
      if (!insight) {
        ownableTx = await runtime.readOwnableTransaction(chain, tx);
      }

      assert(tx.to, 'Warp Module transaction must have a to address');
      const tokenAddress = tx.to.toLowerCase();
      const token = state.warpRouteIndex[chain][tokenAddress];

      return {
        ...ownableTx,
        chain,
        to: `${token.symbol} (${token.name}, ${token.standard}, ${tokenAddress})`,
        insight,
        value: `${ethers.utils.formatEther(decoded.value)} ${symbol}`,
        signature: decoded.signature,
        ...(feeDetails && { feeDetails }),
      };
    },
  };
}
