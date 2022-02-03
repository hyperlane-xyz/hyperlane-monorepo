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

export type NetworkName = Mainnet | Testnet;

export type DomainConfig {
  name: NetworkName;
  domain: number;
}
