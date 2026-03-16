import { ethers } from 'ethers';
import {
  Connection,
  PublicKey,
  type VersionedTransactionResponse,
} from '@solana/web3.js';
import type { Logger } from 'pino';

import {
  HyperlaneCore,
  type MultiProvider,
  SealevelCoreAdapter,
} from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  bytes32ToAddress,
  ensure0x,
  parseMessage,
} from '@hyperlane-xyz/utils';

import { extractRawMessage } from './SvmMessageParser.js';

export interface SvmToEvmRelayOpts {
  connection: Connection;
  mailboxProgramId: PublicKey;
  evmCore: HyperlaneCore;
  multiProvider: MultiProvider;
  logger: Logger;
}

export async function relaySvmToEvmMessages(
  opts: SvmToEvmRelayOpts,
): Promise<number> {
  const signatures = await opts.connection.getSignaturesForAddress(
    opts.mailboxProgramId,
    { limit: 100 },
  );

  const seen = new Set<string>();
  let relayedCount = 0;
  const failures: string[] = [];

  for (const sig of signatures) {
    if (sig.err) continue;

    const tx = await opts.connection.getTransaction(sig.signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    if (!tx) continue;

    const dispatches = SealevelCoreAdapter.parseMessageDispatchLogs(
      tx.meta?.logMessages ?? [],
    );

    for (const dispatch of dispatches) {
      const destinationDomain = Number.parseInt(dispatch.destination, 10);
      if (!Number.isFinite(destinationDomain)) continue;

      const target = resolveTarget(opts, destinationDomain);
      if (!target) continue;

      const id = ensure0x(dispatch.messageId).toLowerCase();
      if (seen.has(id)) continue;
      seen.add(id);

      try {
        await relaySingle(
          opts,
          tx,
          sig.signature,
          id,
          destinationDomain,
          target,
        );
        relayedCount++;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        failures.push(`[${id}] ${target.chain} tx=${sig.signature}: ${reason}`);
      }
    }
  }

  if (failures.length) {
    throw new Error(
      `Failed relaying ${failures.length} SVM->EVM message(s): ${failures.join(' | ')}`,
    );
  }

  return relayedCount;
}

function resolveTarget(
  opts: SvmToEvmRelayOpts,
  destinationDomain: number,
): { chain: string; mailbox: ethers.Contract } | null {
  const chain = opts.multiProvider.tryGetChainName(destinationDomain);
  if (!chain) return null;
  if (opts.multiProvider.getProtocol(chain) !== ProtocolType.Ethereum)
    return null;

  return {
    chain,
    mailbox: opts.evmCore
      .getContracts(chain)
      .mailbox.connect(opts.multiProvider.getSigner(chain)),
  };
}

async function relaySingle(
  opts: SvmToEvmRelayOpts,
  svmTx: VersionedTransactionResponse,
  signature: string,
  messageIdHex: string,
  destinationDomain: number,
  target: { chain: string; mailbox: ethers.Contract },
): Promise<void> {
  if (await target.mailbox.delivered(messageIdHex)) return;

  const message = await extractRawMessage(
    opts.connection,
    opts.mailboxProgramId,
    svmTx,
    messageIdHex,
    destinationDomain,
  );

  if (!message) {
    throw new Error(
      `Unable to reconstruct raw message bytes for ${messageIdHex}; cannot call mailbox.process`,
    );
  }

  try {
    await target.mailbox.callStatic.process('0x', message, {
      gasLimit: 500_000,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (reason.includes('Enrolled router does not match sender')) {
      const parsed = parseMessage(message);
      const recipientRouter = new ethers.Contract(
        bytes32ToAddress(parsed.recipient),
        [
          'function enrollRemoteRouters(uint32[] calldata _domains, bytes32[] calldata _addresses) external',
        ],
        opts.multiProvider.getSigner(target.chain),
      );
      await recipientRouter.enrollRemoteRouters(
        [parsed.origin],
        [parsed.sender],
      );
      await target.mailbox.callStatic.process('0x', message, {
        gasLimit: 500_000,
      });
    } else {
      throw new Error(
        `mailbox.process callStatic reverted for ${messageIdHex}: ${reason}`,
      );
    }
  }

  const relayTx = await target.mailbox.process('0x', message, {
    gasLimit: 500_000,
  });
  await relayTx.wait();

  if (!(await target.mailbox.delivered(messageIdHex))) {
    throw new Error(
      `mailbox.process confirmed but message ${messageIdHex} is not marked delivered`,
    );
  }

  opts.logger.debug(
    { messageId: messageIdHex, destinationChain: target.chain, signature },
    'Relayed SVM-origin message to EVM mailbox',
  );
}
