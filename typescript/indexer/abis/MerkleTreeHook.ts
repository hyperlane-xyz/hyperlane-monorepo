export const MerkleTreeHookAbi = [
  {
    type: 'event',
    name: 'InsertedIntoTree',
    inputs: [
      { name: 'messageId', type: 'bytes32', indexed: false },
      { name: 'index', type: 'uint32', indexed: false },
    ],
  },
] as const;
