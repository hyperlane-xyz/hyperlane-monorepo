import { ChainName, Domain } from './types';

// IDs can be generated in many ways-- for example, in JS:
// > Array.from('celo').map((c, i) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
// '63656c6f'

/**
 * Mainnets
 */
export const celo: Domain = {
  name: 'celo',
  id: 0x63656c6f, // b'celo' interpreted as an int
};

export const ethereum: Domain = {
  name: 'ethereum',
  id: 0x657468, // b'eth' interpreted as an int
};

export const avalanche: Domain = {
  name: 'avalanche',
  id: 0x61766178, // b'avax' interpreted as an int
  paginate: {
    // Needs to be low to avoid RPC timeouts
    blocks: 100000,
    from: 6765067,
  },
};

export const polygon: Domain = {
  name: 'polygon',
  id: 0x706f6c79, // b'poly' interpreted as an int
  paginate: {
    // Needs to be low to avoid RPC timeouts
    blocks: 10000,
    from: 19657100,
  },
};

/**
 * Testnets
 */
export const alfajores: Domain = {
  name: 'alfajores',
  id: 1000,
};

export const fuji: Domain = {
  name: 'fuji',
  id: 43113,
};

export const goerli: Domain = {
  name: 'goerli',
  id: 5,
};

export const kovan: Domain = {
  name: 'kovan',
  id: 3000,
};

export const mumbai: Domain = {
  name: 'mumbai',
  id: 80001,
  paginate: {
    // eth_getLogs and eth_newFilter are limited to a 10,000 blocks range
    blocks: 10000,
    from: 22900000,
  },
};

export const rinkarby: Domain = {
  name: 'rinkarby',
  id: 4000,
};

export const rinkeby: Domain = {
  name: 'rinkeby',
  id: 2000,
};

export const ropsten: Domain = {
  name: 'ropsten',
  id: 3,
};

export const bsctestnet: Domain = {
  name: 'bsctestnet',
  id: 0x62732d74, // b'bs-t' interpreted as an int
};

export const arbitrumrinkeby: Domain = {
  name: 'arbitrumrinkeby',
  id: 0x61722d72, // b'ar-r' interpreted as an int
};

export const optimismkovan: Domain = {
  name: 'optimismkovan',
  id: 0x6f702d6b, // b'op-k' interpreted as an int
};

export const auroratestnet: Domain = {
  name: 'auroratestnet',
  id: 0x61752d74, // b'au-t' interpreted as an int
};

/**
 * Test
 */
export const test1: Domain = {
  name: 'test1',
  id: 1,
};

export const test2: Domain = {
  name: 'test2',
  id: 2,
};

export const test3: Domain = {
  name: 'test3',
  id: 3,
};

export const domains: Record<ChainName, Domain> = {
  celo,
  ethereum,
  avalanche,
  polygon,
  alfajores,
  fuji,
  goerli,
  mumbai,
  rinkeby,
  rinkarby,
  ropsten,
  kovan,
  bsctestnet,
  arbitrumrinkeby,
  optimismkovan,
  auroratestnet,
  test1,
  test2,
  test3,
};
