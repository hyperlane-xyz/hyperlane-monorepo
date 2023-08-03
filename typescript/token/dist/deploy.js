'use strict';
var __awaiter =
  (this && this.__awaiter) ||
  function (thisArg, _arguments, P, generator) {
    function adopt(value) {
      return value instanceof P
        ? value
        : new P(function (resolve) {
            resolve(value);
          });
    }
    return new (P || (P = Promise))(function (resolve, reject) {
      function fulfilled(value) {
        try {
          step(generator.next(value));
        } catch (e) {
          reject(e);
        }
      }
      function rejected(value) {
        try {
          step(generator['throw'](value));
        } catch (e) {
          reject(e);
        }
      }
      function step(result) {
        result.done
          ? resolve(result.value)
          : adopt(result.value).then(fulfilled, rejected);
      }
      step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
  };
Object.defineProperty(exports, '__esModule', { value: true });
exports.HypERC721Deployer = exports.HypERC20Deployer = void 0;
const sdk_1 = require('@hyperlane-xyz/sdk');
const utils_1 = require('@hyperlane-xyz/utils');
const config_1 = require('./config');
const types_1 = require('./types');
class HypERC20Deployer extends sdk_1.GasRouterDeployer {
  constructor(multiProvider) {
    super(multiProvider, {}); // factories not used in deploy
  }
  static fetchMetadata(provider, config) {
    return __awaiter(this, void 0, void 0, function* () {
      const erc20 = types_1.ERC20__factory.connect(config.token, provider);
      const [name, symbol, totalSupply, decimals] = yield Promise.all([
        erc20.name(),
        erc20.symbol(),
        erc20.totalSupply(),
        erc20.decimals(),
      ]);
      return { name, symbol, totalSupply, decimals };
    });
  }
  static gasOverheadDefault(config) {
    switch (config.type) {
      case 'synthetic':
        return 64000;
      case 'native':
        return 44000;
      case 'collateral':
      default:
        return 68000;
    }
  }
  // Gets the metadata for a collateral token, favoring the config
  // and getting any on-chain metadata that is missing.
  getCollateralMetadata(chain, config) {
    return __awaiter(this, void 0, void 0, function* () {
      const metadata = {
        name: config.name,
        symbol: config.symbol,
        decimals: config.decimals,
        totalSupply: 0,
      };
      if (
        metadata.name &&
        metadata.symbol &&
        metadata.decimals !== undefined &&
        metadata.decimals !== null
      ) {
        return metadata;
      }
      const fetchedMetadata = yield HypERC20Deployer.fetchMetadata(
        this.multiProvider.getProvider(chain),
        config,
      );
      // Filter out undefined values
      const definedConfigMetadata = Object.fromEntries(
        Object.entries(metadata).filter(([k, v]) => !!k && !!v),
      );
      return Object.assign(
        Object.assign({}, fetchedMetadata),
        definedConfigMetadata,
      );
    });
  }
  deployCollateral(chain, config) {
    return __awaiter(this, void 0, void 0, function* () {
      const router = yield this.deployContractFromFactory(
        chain,
        new types_1.HypERC20Collateral__factory(),
        'HypERC20Collateral',
        [config.token],
      );
      yield this.multiProvider.handleTx(
        chain,
        router.initialize(config.mailbox, config.interchainGasPaymaster),
      );
      return router;
    });
  }
  deployNative(chain, config) {
    return __awaiter(this, void 0, void 0, function* () {
      const router = yield this.deployContractFromFactory(
        chain,
        new types_1.HypNative__factory(),
        'HypNative',
        [],
      );
      yield this.multiProvider.handleTx(
        chain,
        router.initialize(config.mailbox, config.interchainGasPaymaster),
      );
      return router;
    });
  }
  deploySynthetic(chain, config) {
    return __awaiter(this, void 0, void 0, function* () {
      const router = yield this.deployContractFromFactory(
        chain,
        new types_1.HypERC20__factory(),
        'HypERC20',
        [config.decimals],
      );
      yield this.multiProvider.handleTx(
        chain,
        router.initialize(
          config.mailbox,
          config.interchainGasPaymaster,
          config.totalSupply,
          config.name,
          config.symbol,
        ),
      );
      return router;
    });
  }
  router(contracts) {
    return contracts.router;
  }
  deployContracts(chain, config) {
    return __awaiter(this, void 0, void 0, function* () {
      let router;
      if ((0, config_1.isCollateralConfig)(config)) {
        router = yield this.deployCollateral(chain, config);
      } else if ((0, config_1.isNativeConfig)(config)) {
        router = yield this.deployNative(chain, config);
      } else if ((0, config_1.isSyntheticConfig)(config)) {
        router = yield this.deploySynthetic(chain, config);
      } else {
        throw new Error('Invalid ERC20 token router config');
      }
      return { router };
    });
  }
  buildTokenMetadata(configMap) {
    return __awaiter(this, void 0, void 0, function* () {
      let tokenMetadata;
      for (const [chain, config] of Object.entries(configMap)) {
        if ((0, config_1.isCollateralConfig)(config)) {
          const collateralMetadata = yield this.getCollateralMetadata(
            chain,
            config,
          );
          tokenMetadata = Object.assign(Object.assign({}, collateralMetadata), {
            totalSupply: 0,
          });
        } else if ((0, config_1.isNativeConfig)(config)) {
          const chainMetadata = this.multiProvider.getChainMetadata(chain);
          if (chainMetadata.nativeToken) {
            tokenMetadata = Object.assign(
              Object.assign({}, chainMetadata.nativeToken),
              { totalSupply: 0 },
            );
          } else {
            throw new Error(
              `Warp route config specifies native token but chain metadata for ${chain} does not provide native token details`,
            );
          }
        } else if ((0, config_1.isErc20Metadata)(config)) {
          tokenMetadata = config;
        }
      }
      if (!(0, config_1.isErc20Metadata)(tokenMetadata)) {
        throw new Error('Invalid ERC20 token metadata');
      }
      return (0, utils_1.objMap)(configMap, () => tokenMetadata);
    });
  }
  buildGasOverhead(configMap) {
    return (0, utils_1.objMap)(configMap, (_, config) => ({
      gas: HypERC20Deployer.gasOverheadDefault(config),
    }));
  }
  deploy(configMap) {
    const _super = Object.create(null, {
      deploy: { get: () => super.deploy },
    });
    return __awaiter(this, void 0, void 0, function* () {
      const tokenMetadata = yield this.buildTokenMetadata(configMap);
      const gasOverhead = this.buildGasOverhead(configMap);
      const mergedConfig = (0, utils_1.objMap)(configMap, (chain, config) => {
        return Object.assign(
          Object.assign(
            Object.assign({}, tokenMetadata[chain]),
            gasOverhead[chain],
          ),
          config,
        );
      });
      return _super.deploy.call(this, mergedConfig);
    });
  }
}
exports.HypERC20Deployer = HypERC20Deployer;
class HypERC721Deployer extends sdk_1.GasRouterDeployer {
  constructor(multiProvider) {
    super(multiProvider, {}); // factories not used in deploy
  }
  static fetchMetadata(provider, config) {
    return __awaiter(this, void 0, void 0, function* () {
      const erc721 = types_1.ERC721EnumerableUpgradeable__factory.connect(
        config.token,
        provider,
      );
      const [name, symbol, totalSupply] = yield Promise.all([
        erc721.name(),
        erc721.symbol(),
        erc721.totalSupply(),
      ]);
      return { name, symbol, totalSupply };
    });
  }
  static gasOverheadDefault(config) {
    switch (config.type) {
      case 'synthetic':
        return 160000;
      case 'syntheticUri':
        return 163000;
      case 'collateral':
      case 'collateralUri':
      default:
        return 80000;
    }
  }
  deployCollateral(chain, config) {
    return __awaiter(this, void 0, void 0, function* () {
      let router;
      if ((0, config_1.isUriConfig)(config)) {
        router = yield this.deployContractFromFactory(
          chain,
          new types_1.HypERC721URICollateral__factory(),
          'HypERC721URICollateral',
          [config.token],
        );
      } else {
        router = yield this.deployContractFromFactory(
          chain,
          new types_1.HypERC721Collateral__factory(),
          'HypERC721Collateral',
          [config.token],
        );
      }
      yield this.multiProvider.handleTx(
        chain,
        router.initialize(config.mailbox, config.interchainGasPaymaster),
      );
      return router;
    });
  }
  deploySynthetic(chain, config) {
    return __awaiter(this, void 0, void 0, function* () {
      let router;
      if ((0, config_1.isUriConfig)(config)) {
        router = yield this.deployContractFromFactory(
          chain,
          new types_1.HypERC721URIStorage__factory(),
          'HypERC721URIStorage',
          [],
        );
      } else {
        router = yield this.deployContractFromFactory(
          chain,
          new types_1.HypERC721__factory(),
          'HypERC721',
          [],
        );
      }
      yield this.multiProvider.handleTx(
        chain,
        router.initialize(
          config.mailbox,
          config.interchainGasPaymaster,
          config.totalSupply,
          config.name,
          config.symbol,
        ),
      );
      return router;
    });
  }
  router(contracts) {
    return contracts.router;
  }
  deployContracts(chain, config) {
    return __awaiter(this, void 0, void 0, function* () {
      let router;
      if ((0, config_1.isCollateralConfig)(config)) {
        router = yield this.deployCollateral(chain, config);
      } else if ((0, config_1.isSyntheticConfig)(config)) {
        router = yield this.deploySynthetic(chain, config);
      } else {
        throw new Error('Invalid ERC721 token router config');
      }
      return { router };
    });
  }
  buildTokenMetadata(configMap) {
    return __awaiter(this, void 0, void 0, function* () {
      let tokenMetadata;
      for (const [chain, config] of Object.entries(configMap)) {
        if ((0, config_1.isCollateralConfig)(config)) {
          const collateralMetadata = yield HypERC721Deployer.fetchMetadata(
            this.multiProvider.getProvider(chain),
            config,
          );
          tokenMetadata = Object.assign(Object.assign({}, collateralMetadata), {
            totalSupply: 0,
          });
        } else if ((0, config_1.isTokenMetadata)(config)) {
          tokenMetadata = config;
        }
      }
      if (!(0, config_1.isTokenMetadata)(tokenMetadata)) {
        throw new Error('Invalid ERC721 token metadata');
      }
      return (0, utils_1.objMap)(configMap, () => tokenMetadata);
    });
  }
  buildGasOverhead(configMap) {
    return (0, utils_1.objMap)(configMap, (_, config) => ({
      gas: HypERC721Deployer.gasOverheadDefault(config),
    }));
  }
  deploy(configMap) {
    const _super = Object.create(null, {
      deploy: { get: () => super.deploy },
    });
    return __awaiter(this, void 0, void 0, function* () {
      const tokenMetadata = yield this.buildTokenMetadata(configMap);
      const gasOverhead = this.buildGasOverhead(configMap);
      const mergedConfig = (0, utils_1.objMap)(configMap, (chain, config) => {
        return Object.assign(
          Object.assign(
            Object.assign({}, tokenMetadata[chain]),
            gasOverhead[chain],
          ),
          config,
        );
      });
      return _super.deploy.call(this, mergedConfig);
    });
  }
}
exports.HypERC721Deployer = HypERC721Deployer;
//# sourceMappingURL=deploy.js.map
