import {
  FastHypERC20Collateral__factory,
  FastHypERC20__factory,
  HypERC20Collateral__factory,
  HypERC20__factory,
  HypERC721Collateral__factory,
  HypERC721URICollateral__factory,
  HypERC721__factory,
  HypNative__factory,
} from '@hyperlane-xyz/core';

export type HypERC20Factories = {
  router:
    | HypERC20__factory
    | HypERC20Collateral__factory
    | HypNative__factory
    | FastHypERC20__factory
    | FastHypERC20Collateral__factory;
};
export type HypERC721Factories = {
  router:
    | HypERC721__factory
    | HypERC721Collateral__factory
    | HypERC721URICollateral__factory;
};

export type TokenFactories = HypERC20Factories | HypERC721Factories;
