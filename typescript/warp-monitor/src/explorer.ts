import type { Logger } from 'pino';

import type { ChainName, Token } from '@hyperlane-xyz/sdk';
import {
  bytes32ToAddress,
  isValidAddressEvm,
  isZeroishAddress,
  parseWarpRouteMessage,
} from '@hyperlane-xyz/utils';

const CANONICAL_DECIMALS = 18;

type ExplorerMessageRow = {
  msg_id: string;
  origin_domain_id: number;
  destination_domain_id: number;
  sender: string;
  recipient: string;
  message_body: string;
  send_occurred_at: string | null;
};

export type RouterNodeMetadata = {
  nodeId: string;
  chainName: ChainName;
  domainId: number;
  routerAddress: string;
  tokenAddress: string;
  tokenName: string;
  tokenSymbol: string;
  tokenDecimals: number;
  token: Token;
};

export type PendingDestinationTransfer = {
  messageId: string;
  originDomainId: number;
  destinationDomainId: number;
  destinationChain: ChainName;
  destinationNodeId: string;
  destinationRouter: string;
  amountBaseUnits: bigint;
  sendOccurredAtMs?: number;
};

export function normalizeExplorerHex(hex: string): string {
  if (!hex) return hex;
  return hex.startsWith('\\x') ? `0x${hex.slice(2)}` : hex;
}

export function normalizeExplorerAddress(address: string): string {
  const normalized = normalizeExplorerHex(address).toLowerCase();
  if (!normalized.startsWith('0x')) return normalized;
  // Explorer can return 32-byte padded addresses. Keep low 20 bytes for EVM.
  if (normalized.length === 66) return `0x${normalized.slice(26)}`;
  return normalized;
}

function isValidEvmWarpRecipient(recipientBytes32: string): boolean {
  const normalized = normalizeExplorerHex(recipientBytes32).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) return false;
  // EVM warp recipients should be left-padded 20-byte addresses.
  if (!normalized.startsWith('0x000000000000000000000000')) return false;

  try {
    const recipient = bytes32ToAddress(normalized);
    return isValidAddressEvm(recipient) && !isZeroishAddress(recipient);
  } catch {
    return false;
  }
}

export function canonical18ToTokenBaseUnits(
  amountCanonical18: bigint,
  tokenDecimals: number,
): bigint {
  if (tokenDecimals === CANONICAL_DECIMALS) return amountCanonical18;
  if (tokenDecimals < CANONICAL_DECIMALS) {
    const divisor = 10n ** BigInt(CANONICAL_DECIMALS - tokenDecimals);
    return amountCanonical18 / divisor;
  }

  const multiplier = 10n ** BigInt(tokenDecimals - CANONICAL_DECIMALS);
  return amountCanonical18 * multiplier;
}

export class ExplorerPendingTransfersClient {
  private readonly routers: string[];
  private readonly domains: number[];
  private readonly nodeByDestinationKey: Map<string, RouterNodeMetadata>;

  constructor(
    private readonly apiUrl: string,
    nodes: RouterNodeMetadata[],
    private readonly logger: Logger,
  ) {
    const routers = new Set<string>();
    const domains = new Set<number>();
    this.nodeByDestinationKey = new Map<string, RouterNodeMetadata>();

    for (const node of nodes) {
      const routerLower = node.routerAddress.toLowerCase();
      routers.add(routerLower);
      domains.add(node.domainId);
      this.nodeByDestinationKey.set(`${node.domainId}:${routerLower}`, node);
    }

    this.routers = [...routers];
    this.domains = [...domains];
  }

  async getPendingDestinationTransfers(
    limit = 200,
  ): Promise<PendingDestinationTransfer[]> {
    const rows = await this.queryInflightTransfers(limit);
    const transfers: PendingDestinationTransfer[] = [];

    for (const row of rows) {
      const destinationRouter = normalizeExplorerAddress(row.recipient);
      const destinationKey = `${row.destination_domain_id}:${destinationRouter.toLowerCase()}`;
      const node = this.nodeByDestinationKey.get(destinationKey);
      if (!node) continue;

      let parsedMessage: ReturnType<typeof parseWarpRouteMessage>;
      try {
        parsedMessage = parseWarpRouteMessage(
          normalizeExplorerHex(row.message_body),
        );
      } catch (error) {
        this.logger.debug(
          {
            messageId: row.msg_id,
            destinationDomainId: row.destination_domain_id,
            destinationRouter,
            error: (error as Error).message,
          },
          'Skipping explorer message with unparsable warp message body',
        );
        continue;
      }
      if (!isValidEvmWarpRecipient(parsedMessage.recipient)) {
        this.logger.debug(
          {
            messageId: row.msg_id,
            destinationDomainId: row.destination_domain_id,
            destinationRouter,
            recipient: parsedMessage.recipient,
          },
          'Skipping explorer message with malformed recipient bytes32',
        );
        continue;
      }

      const sendOccurredAtMs = this.parseSendOccurredAt(row.send_occurred_at);

      transfers.push({
        messageId: normalizeExplorerHex(row.msg_id),
        originDomainId: row.origin_domain_id,
        destinationDomainId: row.destination_domain_id,
        destinationChain: node.chainName,
        destinationNodeId: node.nodeId,
        destinationRouter,
        amountBaseUnits: canonical18ToTokenBaseUnits(
          parsedMessage.amount,
          node.tokenDecimals,
        ),
        sendOccurredAtMs,
      });
    }

    return transfers;
  }

  private parseSendOccurredAt(
    sendOccurredAt: string | null,
  ): number | undefined {
    if (!sendOccurredAt) return undefined;
    const parsed = Date.parse(sendOccurredAt);
    if (Number.isNaN(parsed)) return undefined;
    return parsed;
  }

  private toBytea(address: string): string {
    return address.replace(/^0x/i, '\\x').toLowerCase();
  }

  private async queryInflightTransfers(
    limit: number,
  ): Promise<ExplorerMessageRow[]> {
    if (this.routers.length === 0 || this.domains.length === 0) return [];

    const variables = {
      senders: this.routers.map((router) => this.toBytea(router)),
      recipients: this.routers.map((router) => this.toBytea(router)),
      originDomains: this.domains,
      destinationDomains: this.domains,
      limit,
    };

    const query = `
      query WarpMonitorInflightTransfers(
        $senders: [bytea!],
        $recipients: [bytea!],
        $originDomains: [Int!],
        $destinationDomains: [Int!],
        $limit: Int = 200
      ) {
        message_view(
          where: {
            _and: [
              { is_delivered: { _eq: false } },
              { sender: { _in: $senders } },
              { recipient: { _in: $recipients } },
              { origin_domain_id: { _in: $originDomains } },
              { destination_domain_id: { _in: $destinationDomains } }
            ]
          }
          order_by: { origin_tx_id: desc }
          limit: $limit
        ) {
          msg_id
          origin_domain_id
          destination_domain_id
          sender
          recipient
          message_body
          send_occurred_at
        }
      }
    `;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });

      if (!response.ok) {
        let details: string;
        try {
          details = JSON.stringify(await response.json());
        } catch {
          details = await response.text();
        }

        throw new Error(
          `Explorer query failed: ${response.status} ${response.statusText} ${details}`,
        );
      }

      const payload: {
        data?: { message_view?: ExplorerMessageRow[] };
        errors?: unknown;
      } = await response.json();

      if (payload.errors) {
        throw new Error(
          `Explorer query returned GraphQL errors: ${JSON.stringify(payload.errors)}`,
        );
      }

      return payload.data?.message_view ?? [];
    } finally {
      clearTimeout(timeout);
    }
  }
}
