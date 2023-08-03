'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.isUriConfig =
  exports.isNativeConfig =
  exports.isSyntheticConfig =
  exports.isCollateralConfig =
  exports.isErc20Metadata =
  exports.isTokenMetadata =
  exports.TokenType =
    void 0;
var TokenType;
(function (TokenType) {
  TokenType['synthetic'] = 'synthetic';
  TokenType['syntheticUri'] = 'syntheticUri';
  TokenType['collateral'] = 'collateral';
  TokenType['collateralUri'] = 'collateralUri';
  TokenType['native'] = 'native';
})((TokenType = exports.TokenType || (exports.TokenType = {})));
const isTokenMetadata = (metadata) =>
  metadata.name && metadata.symbol && metadata.totalSupply !== undefined; // totalSupply can be 0
exports.isTokenMetadata = isTokenMetadata;
const isErc20Metadata = (metadata) =>
  metadata.decimals && (0, exports.isTokenMetadata)(metadata);
exports.isErc20Metadata = isErc20Metadata;
const isCollateralConfig = (config) =>
  config.type === TokenType.collateral ||
  config.type === TokenType.collateralUri;
exports.isCollateralConfig = isCollateralConfig;
const isSyntheticConfig = (config) =>
  config.type === TokenType.synthetic || config.type === TokenType.syntheticUri;
exports.isSyntheticConfig = isSyntheticConfig;
const isNativeConfig = (config) => config.type === TokenType.native;
exports.isNativeConfig = isNativeConfig;
const isUriConfig = (config) =>
  config.type === TokenType.syntheticUri ||
  config.type === TokenType.collateralUri;
exports.isUriConfig = isUriConfig;
//# sourceMappingURL=config.js.map
