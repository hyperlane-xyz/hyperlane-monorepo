type Address = string;
type Mainnet =
  | 'celo'
  | 'polygon'
  | 'avalanche'
  | 'polygon';

type Testnet =
  | 'alfajores'
  | 'mumbai'
  | 'kovan'
  | 'gorli'
  | 'fuji'
  | 'rinkeby';

export type Network = Mainnet | Testnet;

export interface ChainConfig {
  name: Network;
  domain: number;
}
