'use strict';
var __createBinding =
  (this && this.__createBinding) ||
  (Object.create
    ? function (o, m, k, k2) {
        if (k2 === undefined) k2 = k;
        var desc = Object.getOwnPropertyDescriptor(m, k);
        if (
          !desc ||
          ('get' in desc ? !m.__esModule : desc.writable || desc.configurable)
        ) {
          desc = {
            enumerable: true,
            get: function () {
              return m[k];
            },
          };
        }
        Object.defineProperty(o, k2, desc);
      }
    : function (o, m, k, k2) {
        if (k2 === undefined) k2 = k;
        o[k2] = m[k];
      });
var __exportStar =
  (this && this.__exportStar) ||
  function (m, exports) {
    for (var p in m)
      if (p !== 'default' && !Object.prototype.hasOwnProperty.call(exports, p))
        __createBinding(exports, m, p);
  };
Object.defineProperty(exports, '__esModule', { value: true });
exports.HypERC721Deployer =
  exports.HypERC20Deployer =
  exports.isUriConfig =
  exports.isCollateralConfig =
  exports.TokenType =
  exports.HypERC721App =
  exports.HypERC20App =
    void 0;
var app_1 = require('./app');
Object.defineProperty(exports, 'HypERC20App', {
  enumerable: true,
  get: function () {
    return app_1.HypERC20App;
  },
});
Object.defineProperty(exports, 'HypERC721App', {
  enumerable: true,
  get: function () {
    return app_1.HypERC721App;
  },
});
var config_1 = require('./config');
Object.defineProperty(exports, 'TokenType', {
  enumerable: true,
  get: function () {
    return config_1.TokenType;
  },
});
Object.defineProperty(exports, 'isCollateralConfig', {
  enumerable: true,
  get: function () {
    return config_1.isCollateralConfig;
  },
});
Object.defineProperty(exports, 'isUriConfig', {
  enumerable: true,
  get: function () {
    return config_1.isUriConfig;
  },
});
var deploy_1 = require('./deploy');
Object.defineProperty(exports, 'HypERC20Deployer', {
  enumerable: true,
  get: function () {
    return deploy_1.HypERC20Deployer;
  },
});
Object.defineProperty(exports, 'HypERC721Deployer', {
  enumerable: true,
  get: function () {
    return deploy_1.HypERC721Deployer;
  },
});
__exportStar(require('./types'), exports);
//# sourceMappingURL=index.js.map
