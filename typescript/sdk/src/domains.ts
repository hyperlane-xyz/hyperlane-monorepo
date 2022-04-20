import { ChainMap, Domain } from './types';

/**
 * Mainnets
 */
export const celo: Domain = {
  id: 0x63656c6f, // b'celo' interpreted as an int
};

export const ethereum: Domain = {
  id: 0x657468, // b'eth' interpreted as an int
};

export const avalanche: Domain = {
  id: 0x61766178, // b'avax' interpreted as an int
  paginate: {
    // Needs to be low to avoid RPC timeouts
    blocks: 100000,
    from: 6765067,
  },
};

export const polygon: Domain = {
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
  id: 1000,
};

export const fuji: Domain = {
  id: 43113,
};

export const goerli: Domain = {
  id: 5,
};

export const kovan: Domain = {
  id: 3000,
};

export const mumbai: Domain = {
  id: 80001,
  paginate: {
    // eth_getLogs and eth_newFilter are limited to a 10,000 blocks range
    blocks: 10000,
    from: 22900000,
  },
};

export const rinkarby: Domain = {
  id: 4000,
};

export const rinkeby: Domain = {
  id: 2000,
};

export const ropsten: Domain = {
  id: 3,
};

export const domains: ChainMap<Domain> = {
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
};
