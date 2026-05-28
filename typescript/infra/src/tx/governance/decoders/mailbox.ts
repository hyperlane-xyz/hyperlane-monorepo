import { coreFactories } from '@hyperlane-xyz/sdk';
import { eqAddress } from '@hyperlane-xyz/utils';

import { formatFunctionFragmentArgs } from '../utils.js';
import { validateDefaultIsmConfig } from '../validation.js';
import type { GovernanceDecoder } from '../types.js';

export function createMailboxDecoder(): GovernanceDecoder {
  return {
    id: 'mailbox',
    priority: 40,
    match: ({ state, chain, tx }) => {
      const mailbox = state.chainAddresses[chain]?.mailbox;
      return tx.to !== undefined && mailbox && eqAddress(tx.to, mailbox)
        ? true
        : undefined;
    },
    decode: async ({ runtime, state, chain, tx }) => {
      if (!tx.data) {
        throw new Error('⚠️ No data in mailbox transaction');
      }
      const mailboxInterface = coreFactories.mailbox.interface;
      const decoded = mailboxInterface.parseTransaction({
        data: tx.data,
        value: tx.value,
      });

      const args = formatFunctionFragmentArgs(
        decoded.args,
        decoded.functionFragment,
      );
      let prettyArgs = args;
      if (
        decoded.functionFragment.name ===
        mailboxInterface.functions['setDefaultIsm(address)'].name
      ) {
        prettyArgs = await validateDefaultIsmConfig(
          state,
          chain,
          String(args._module),
        );
      } else if (decoded.signature === 'transferOwnership(address)') {
        const ownableTx = await runtime.readOwnableTransaction(chain, tx);
        return {
          ...ownableTx,
          to: `Mailbox (${chain} ${state.chainAddresses[chain].mailbox})`,
          signature: decoded.signature,
        };
      }

      return {
        chain,
        to: `Mailbox (${chain} ${state.chainAddresses[chain].mailbox})`,
        signature: decoded.signature,
        args: prettyArgs,
      };
    },
  };
}
