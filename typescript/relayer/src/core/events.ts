import type {DispatchedMessage, MultiProvider} from "@hyperlane-xyz/sdk";

type DispatchReceipt = Awaited<
    ReturnType<
        ReturnType<MultiProvider["getProvider"]>["getTransactionReceipt"]
    >
>;

/**
 * Relayer events, useful for metrics and monitoring
 */
export type RelayerEvent =
    | {
          type: "messageRelayed";
          message: DispatchedMessage;
          originChain: string;
          destinationChain: string;
          messageId: string;
          durationMs: number;
          dispatchTx?: DispatchReceipt;
      }
    | {
          type: "messageFailed";
          message: DispatchedMessage;
          originChain: string;
          destinationChain: string;
          messageId: string;
          error: Error;
          dispatchTx?: DispatchReceipt;
      }
    | {
          type: "messageSkipped";
          message: DispatchedMessage;
          originChain: string;
          destinationChain: string;
          messageId: string;
          reason: "whitelist" | "already_delivered";
          dispatchTx?: DispatchReceipt;
      }
    | {
          type: "retry";
          message: DispatchedMessage;
          originChain: string;
          destinationChain: string;
          messageId: string;
          attempt: number;
      }
    | {type: "backlog"; size: number};

export interface RelayerObserver {
    onEvent?: (event: RelayerEvent) => void;
}
