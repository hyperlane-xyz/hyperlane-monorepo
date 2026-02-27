export const InterchainGasPaymasterAbi = [
  {
    type: 'event',
    name: 'GasPayment',
    inputs: [
      { name: 'messageId', type: 'bytes32', indexed: true },
      { name: 'destinationDomain', type: 'uint32', indexed: true },
      { name: 'gasAmount', type: 'uint256', indexed: false },
      { name: 'payment', type: 'uint256', indexed: false },
    ],
  },
] as const;
