import { TimelockController__factory } from '@hyperlane-xyz/core';
import { eqAddress } from '@hyperlane-xyz/utils';

import { timelocks as legacyTimelocks } from '../../../../config/environments/mainnet3/owners.js';
import type { GovernanceDecoder } from '../types.js';
import { formatFunctionFragmentArgs } from '../utils.js';

export function createTimelockDecoder(): GovernanceDecoder {
  return {
    id: 'timelock',
    priority: 50,
    match: ({ state, chain, tx }) => {
      if (!tx.to) return undefined;
      const isNewTimelock =
        state.timelocks[chain] !== undefined &&
        eqAddress(tx.to, state.timelocks[chain]!);
      const isLegacyTimelock =
        legacyTimelocks[chain] !== undefined &&
        eqAddress(tx.to, legacyTimelocks[chain]!);
      return isNewTimelock || isLegacyTimelock ? true : undefined;
    },
    decode: async ({ runtime, chain, tx }) => {
      if (!tx.data) {
        throw new Error('No data in TimelockController transaction');
      }

      const timelockControllerInterface =
        TimelockController__factory.createInterface();
      const decoded = timelockControllerInterface.parseTransaction({
        data: tx.data,
        value: tx.value,
      });

      let insight;
      let calls;
      if (
        decoded.functionFragment.name ===
        timelockControllerInterface.functions[
          'schedule(address,uint256,bytes,bytes32,bytes32,uint256)'
        ].name
      ) {
        const [target, value, data, _predecessor, _salt, delay] = decoded.args;
        const inner = await runtime.read(chain, {
          to: target,
          data,
          value,
        });

        const eta = new Date(Date.now() + delay.toNumber() * 1000);
        insight = `Schedule for ${eta}: ${JSON.stringify(inner)}`;
      }

      if (
        decoded.functionFragment.name ===
        timelockControllerInterface.functions[
          'scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)'
        ].name
      ) {
        const [targets, values, data, _predecessor, _salt, delay] =
          decoded.args;

        calls = [];
        const numOfTxs = targets.length;
        for (let i = 0; i < numOfTxs; i++) {
          calls.push(
            await runtime.read(chain, {
              to: targets[i],
              data: data[i],
              value: values[i],
            }),
          );
        }

        const eta = new Date(Date.now() + delay.toNumber() * 1000);
        insight = `Schedule for ${eta}`;
      }

      if (
        decoded.functionFragment.name ===
        timelockControllerInterface.functions[
          'execute(address,uint256,bytes,bytes32,bytes32)'
        ].name
      ) {
        const [target, value, data, executor] = decoded.args;
        insight = `Execute ${target} with ${value} ${data}. Executor: ${executor}`;
      }

      if (
        decoded.functionFragment.name ===
        timelockControllerInterface.functions[
          'executeBatch(address[],uint256[],bytes[],bytes32,bytes32)'
        ].name
      ) {
        const [targets, values, data] = decoded.args;

        calls = [];
        const numOfTxs = targets.length;
        for (let i = 0; i < numOfTxs; i++) {
          calls.push(
            await runtime.read(chain, {
              to: targets[i],
              data: data[i],
              value: values[i],
            }),
          );
        }

        insight = `Execute batch on ${targets}`;
      }

      if (
        decoded.functionFragment.name ===
        timelockControllerInterface.functions['cancel(bytes32)'].name
      ) {
        const [id] = decoded.args;
        insight = `Cancel scheduled transaction ${id}`;
      }

      const args = formatFunctionFragmentArgs(
        decoded.args,
        decoded.functionFragment,
      );

      return {
        chain,
        to: `Timelock Controller (${chain} ${tx.to})`,
        ...(insight ? { insight } : { args }),
        ...(calls ? { innerTxs: calls } : {}),
      };
    },
  };
}
