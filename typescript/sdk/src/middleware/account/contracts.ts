import {
  InterchainAccountIsm__factory,
  InterchainAccountRouter__factory,
} from '@hyperlane-xyz/core';
import {
  InterchainAccountIsm__artifact,
  InterchainAccountRouter__artifact,
} from '@hyperlane-xyz/core/artifacts';

import {
  proxiedFactories,
  proxiedFactoriesArtifacts,
} from '../../router/types.js';

export const interchainAccountFactories = {
  interchainAccountRouter: new InterchainAccountRouter__factory(),
  interchainAccountIsm: new InterchainAccountIsm__factory(),
  ...proxiedFactories,
};
export const interchainAccountFactoriesArtifacts = {
  interchainAccountRouter: InterchainAccountRouter__artifact,
  interchainAccountIsm: InterchainAccountIsm__artifact,
  ...proxiedFactoriesArtifacts,
};

export type InterchainAccountFactories = typeof interchainAccountFactories;
