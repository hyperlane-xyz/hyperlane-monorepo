import {
  HypERC20Collateral__factory,
  HypERC20__factory,
  HypERC721Collateral__factory,
  HypERC721URICollateral__factory,
  HypERC721__factory,
  HypNative__factory,
} from './types';

export declare type HypERC20Factories = {
  router: HypERC20__factory | HypERC20Collateral__factory | HypNative__factory;
};
export declare type HypERC721Factories = {
  router:
    | HypERC721__factory
    | HypERC721Collateral__factory
    | HypERC721URICollateral__factory;
};
export declare type TokenFactories = HypERC20Factories | HypERC721Factories;
//# sourceMappingURL=contracts.d.ts.map
