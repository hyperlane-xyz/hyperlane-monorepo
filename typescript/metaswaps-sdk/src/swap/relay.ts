import { ethers } from 'ethers';
import {
  CCTP_MESSAGE_SENT_TOPIC,
  CCTP_MESSAGE_TRANSMITTER_ADDRESSES,
  REGISTRY_CHAIN_NAMES,
} from '../utils/constants.js';

// POST {relayApiUrl}/relay with this body.
interface RelayPayload {
  origin_chain: string;
  tx_hash: string;
}

interface RelayResponse {
  messages: Array<{
    message_id: string;
    origin: number;
    destination: number;
    nonce: number;
  }>;
}

function hasCctpMessage(receipt: ethers.providers.TransactionReceipt): boolean {
  return receipt.logs.some(
    (log) =>
      log.topics[0] === CCTP_MESSAGE_SENT_TOPIC &&
      CCTP_MESSAGE_TRANSMITTER_ADDRESSES.has(log.address.toLowerCase()),
  );
}

// Fire-and-forget: submits the origin tx to the relay API if CCTP messages are detected.
// Errors are swallowed — relay is a best-effort optimisation, not required for correctness.
export async function maybeSubmitToRelayApi(
  receipt: ethers.providers.TransactionReceipt,
  srcChainId: number,
  relayApiUrl: string,
): Promise<void> {
  if (!hasCctpMessage(receipt)) return;

  const chainName = REGISTRY_CHAIN_NAMES[srcChainId];
  if (!chainName) return;

  const url = `${relayApiUrl.replace(/\/$/, '')}/relay`;
  const payload: RelayPayload = {
    origin_chain: chainName,
    tx_hash: receipt.transactionHash,
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      const data: RelayResponse = await res.json();
      void data; // response is informational only
    }
  } catch {
    // Relay submission failure is non-fatal.
  }
}
