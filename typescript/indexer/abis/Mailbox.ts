export const MailboxAbi = [
  {
    type: 'event',
    name: 'Dispatch',
    inputs: [
      { name: 'sender', type: 'address', indexed: true },
      { name: 'destination', type: 'uint32', indexed: true },
      { name: 'recipient', type: 'bytes32', indexed: true },
      { name: 'message', type: 'bytes', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'DispatchId',
    inputs: [{ name: 'messageId', type: 'bytes32', indexed: true }],
  },
  {
    type: 'event',
    name: 'Process',
    inputs: [
      { name: 'origin', type: 'uint32', indexed: true },
      { name: 'sender', type: 'bytes32', indexed: true },
      { name: 'recipient', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'ProcessId',
    inputs: [{ name: 'messageId', type: 'bytes32', indexed: true }],
  },
] as const;
