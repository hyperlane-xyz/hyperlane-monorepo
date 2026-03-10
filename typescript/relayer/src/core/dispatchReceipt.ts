export type DispatchReceipt = {
  logs: readonly {
    address: string;
    topics: readonly string[];
    data: string;
  }[];
} & ({ hash: string } | { transactionHash: string });

export function toDispatchReceipt(receipt: DispatchReceipt): DispatchReceipt {
  return {
    logs: receipt.logs.map(({ address, topics, data }) => ({
      address,
      topics,
      data,
    })),
    ...('transactionHash' in receipt
      ? { transactionHash: receipt.transactionHash }
      : { hash: receipt.hash }),
  };
}
