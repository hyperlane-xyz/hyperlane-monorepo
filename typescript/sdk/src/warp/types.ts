import { ChainName } from '../types';

// Map of protocol to either quote constant or to a map of chain name to quote constant
export type IgpQuoteConstants = Array<{
  origin: ChainName;
  destination: ChainName;
  quote: string | number | bigint;
}>;

export type RouteBlacklist = Array<{
  origin: ChainName;
  destination: ChainName;
}>;
