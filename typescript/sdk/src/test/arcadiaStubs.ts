export const mockArcadiaSdkInstance = {
  walletService: {
    getArcadiaChainInfo: () => ({
      rpcUrl: ['http://localhost:8545'],
      chainId: 9913372,
    }),
  },
  contractService: {
    getIntentBookAddress: () => '0x123',
    getMTokenAddress: () => '0x456',
    getMTokenABI: () => [],
    getAssetReservesABI: () => [],
    getIntentBookABI: () => [],
  },
  tokensService: {
    getTokenInDestinyChain: () => ({ address: '0x123' }),
  },
  intentService: {
    buildSignIntentPayload: async () => ({}),
    proposeIntent: async () => ({ transactionHash: '0x', intentId: '0x' }),
  },
  refineService: {
    createRefine: async () => 'refine-id',
    queryRefine: async () => ({
      Refinement: { outcome: { mAmounts: ['100'] } },
    }),
  },
  tokenUtils: {
    findTokenByAddress: () => ({
      address: '0x8358D8291e3bEDb04804975eEa0fe9fe0fAfB147',
      decimals: 6,
      symbol: 'USDC',
      name: 'USDC',
    }),
    findArcadiaToken: () => ({
      address: '0x8358D8291e3bEDb04804975eEa0fe9fe0fAfB147',
      decimals: 6,
      symbol: 'USDC',
      name: 'USDC',
    }),
  },
};
