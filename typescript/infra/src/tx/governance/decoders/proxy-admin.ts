import { ProxyAdmin__factory } from '@hyperlane-xyz/core';
import { isProxyAdminFromBytecode } from '@hyperlane-xyz/sdk';

import type { GovernanceDecoder } from '../types.js';
import { formatFunctionFragmentArgs } from '../utils.js';

export function createProxyAdminDecoder(): GovernanceDecoder {
  return {
    id: 'proxy-admin',
    priority: 130,
    match: async ({ state, chain, tx }) => {
      if (tx.to === undefined) return undefined;

      if (tx.to === state.chainAddresses[chain].proxyAdmin) {
        return true;
      }

      return (await isProxyAdminFromBytecode(
        state.multiProvider.getProvider(chain),
        tx.to,
      ))
        ? true
        : undefined;
    },
    decode: async ({ runtime, state, chain, tx }) => {
      if (!tx.data) {
        throw new Error('⚠️ No data in proxyAdmin transaction');
      }

      const proxyAdminInterface = ProxyAdmin__factory.createInterface();
      const decoded = proxyAdminInterface.parseTransaction({
        data: tx.data,
        value: tx.value,
      });

      let insight: string | undefined;
      const args = formatFunctionFragmentArgs(
        decoded.args,
        decoded.functionFragment,
      );

      switch (decoded.functionFragment.name) {
        case proxyAdminInterface.functions['upgrade(address,address)'].name: {
          const [proxy, implementation] = decoded.args;
          insight = `Upgrade proxy ${proxy} to implementation ${implementation}`;
          break;
        }
        case proxyAdminInterface.functions[
          'upgradeAndCall(address,address,bytes)'
        ].name: {
          const [proxy, implementation] = decoded.args;
          insight = `Upgrade proxy ${proxy} to implementation ${implementation} with initialization data`;
          break;
        }
        case proxyAdminInterface.functions['changeProxyAdmin(address,address)']
          .name: {
          const [proxy, newAdmin] = decoded.args;
          insight = `Change admin of proxy ${proxy} to ${newAdmin}`;
          break;
        }
        case proxyAdminInterface.functions['getProxyImplementation(address)']
          .name: {
          const [proxy] = decoded.args;
          insight = `Get implementation address for proxy ${proxy}`;
          break;
        }
        case proxyAdminInterface.functions['getProxyAdmin(address)'].name: {
          const [proxy] = decoded.args;
          insight = `Get admin address for proxy ${proxy}`;
          break;
        }
        default: {
          const ownableTx = await runtime.readOwnableTransaction(chain, tx);
          return {
            ...ownableTx,
            to: `Proxy Admin (${chain} ${state.chainAddresses[chain].proxyAdmin})`,
            signature: decoded.signature,
          };
        }
      }

      return {
        chain,
        to: `Proxy Admin (${chain} ${state.chainAddresses[chain].proxyAdmin})`,
        signature: decoded.signature,
        ...(insight ? { insight } : { args }),
      };
    },
  };
}
