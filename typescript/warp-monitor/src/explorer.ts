import type { Logger } from 'pino';

import {
  localAmountFromMessage,
  type ChainName,
  type ScaleInput,
  type Token,
} from '@hyperlane-xyz/sdk';
import {
  assert,
  bytes32ToAddress,
  isValidAddressEvm,
  isZeroishAddress,
  parseWarpRouteMessage,
} from '@hyperlane-xyz/utils';

import { DEFAULT_EXPLORER_QUERY_LIMIT } from './constants.js';

const MESSAGE_ID_REGEX = /^0x[0-9a-f]{64}$/;
const HEX_PREFIX_REGEX = /^0x/i;
// The proxy's history filter policy applies to every route on the endpoint.
const unsupportedPendingEndpoints = new Set<string>();

type ExplorerMessageRow = {
  msg_id: string;
  origin_domain_id: number;
  destination_domain_id: number;
  sender: string;
  recipient: string;
  message_body: string;
  send_occurred_at: string | null;
  send_scraped_at: string;
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
  tokenScale?: ScaleInput;
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
  if (!MESSAGE_ID_REGEX.test(normalized)) return false;
  // EVM warp recipients should be left-padded 20-byte addresses.
  if (!normalized.startsWith('0x000000000000000000000000')) return false;

  try {
    const recipient = bytes32ToAddress(normalized);
    return isValidAddressEvm(recipient) && !isZeroishAddress(recipient);
  } catch {
    return false;
  }
}

export function messageAmountToTokenBaseUnits(
  amountMessageUnits: bigint,
  tokenScale?: ScaleInput,
): bigint {
  return localAmountFromMessage(amountMessageUnits, tokenScale);
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
    limit = DEFAULT_EXPLORER_QUERY_LIMIT,
  ): Promise<PendingDestinationTransfer[] | null> {
    if (unsupportedPendingEndpoints.has(this.apiUrl)) return null;
    const rows = await this.queryInflightTransfers(limit);
    if (rows === null) return null;
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
            error: error instanceof Error ? error.message : String(error),
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

      // Fallback rows have no transaction/block timestamp. Their scrape time
      // is less precise, but still prevents permanently suppressing age-based
      // pending alerts for those messages.
      const sendOccurredAtMs = this.parseSendOccurredAt(
        row.send_occurred_at ?? row.send_scraped_at,
      );

      transfers.push({
        messageId: normalizeExplorerHex(row.msg_id),
        originDomainId: row.origin_domain_id,
        destinationDomainId: row.destination_domain_id,
        destinationChain: node.chainName,
        destinationNodeId: node.nodeId,
        destinationRouter,
        amountBaseUnits: messageAmountToTokenBaseUnits(
          parsedMessage.amount,
          node.tokenScale,
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
    return address.replace(HEX_PREFIX_REGEX, '\\x').toLowerCase();
  }

  private async queryInflightTransfers(
    limit: number,
  ): Promise<ExplorerMessageRow[] | null> {
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
          order_by: { id: desc }
          limit: $limit
        ) {
          msg_id
          origin_domain_id
          destination_domain_id
          sender
          recipient
          message_body
          send_occurred_at
          send_scraped_at
        }
      }
    `;

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, 10_000);

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
        errors?: { message: string }[];
      } = await response.json();

      if (
        payload.errors?.some(
          ({ message }) =>
            message ===
            'Delivery status filters require a provisional-only feed',
        )
      ) {
        if (!unsupportedPendingEndpoints.has(this.apiUrl)) {
          unsupportedPendingEndpoints.add(this.apiUrl);
          this.logger.error(
            'The Explorer GraphQL API does not support filtering finalized messages by delivery status. Pending transfer and projected deficit metrics are unavailable. Restart the monitor after the API supports this query.',
          );
        }
        return null;
      }
      if (payload.errors?.length) {
        throw new Error(
          `Explorer query returned GraphQL errors: ${JSON.stringify(payload.errors)}`,
        );
      }

      const rows = payload.data?.message_view;
      assert(Array.isArray(rows), 'Explorer query returned no message_view');
      return rows;
    } finally {
      clearTimeout(timeout);
    }
  }
}
