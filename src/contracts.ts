import { RouterContracts } from '@hyperlane-xyz/sdk';

import {
  HypERC20,
  HypERC20Collateral,
  HypERC721,
  HypERC721Collateral,
  HypERC721URICollateral,
  HypNative,
} from './types';

export type HypERC20Contracts = RouterContracts<HypERC20 | HypERC20Collateral | HypNative>;
export type HypERC721Contracts = RouterContracts<
  HypERC721 | HypERC721Collateral | HypERC721URICollateral
>;
