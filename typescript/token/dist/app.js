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
exports.HypERC721App = exports.HypERC20App = void 0;
const sdk_1 = require('@hyperlane-xyz/sdk');
class HyperlaneTokenApp extends sdk_1.RouterApp {
  router(contracts) {
    return contracts.router;
  }
  transfer(origin, destination, recipient, amountOrId) {
    return __awaiter(this, void 0, void 0, function* () {
      const originRouter = this.getContracts(origin).router;
      const destProvider = this.multiProvider.getProvider(destination);
      const destinationNetwork = yield destProvider.getNetwork();
      const gasPayment = yield originRouter.quoteGasPayment(
        destinationNetwork.chainId,
      );
      return this.multiProvider.handleTx(
        origin,
        originRouter.transferRemote(
          destinationNetwork.chainId,
          recipient,
          amountOrId,
          {
            value: gasPayment,
          },
        ),
      );
    });
  }
}
class HypERC20App extends HyperlaneTokenApp {
  transfer(origin, destination, recipient, amount) {
    const _super = Object.create(null, {
      transfer: { get: () => super.transfer },
    });
    return __awaiter(this, void 0, void 0, function* () {
      const originRouter = this.getContracts(origin).router;
      const signerAddress = yield this.multiProvider.getSignerAddress(origin);
      const balance = yield originRouter.balanceOf(signerAddress);
      if (balance.lt(amount))
        console.warn(
          `Signer ${signerAddress} has insufficient balance ${balance}, needs ${amount} on ${origin}`,
        );
      return _super.transfer.call(this, origin, destination, recipient, amount);
    });
  }
}
exports.HypERC20App = HypERC20App;
class HypERC721App extends HyperlaneTokenApp {
  transfer(origin, destination, recipient, tokenId) {
    const _super = Object.create(null, {
      transfer: { get: () => super.transfer },
    });
    return __awaiter(this, void 0, void 0, function* () {
      const originRouter = this.getContracts(origin).router;
      const signerAddress = yield this.multiProvider.getSignerAddress(origin);
      const owner = yield originRouter.ownerOf(tokenId);
      if (signerAddress != owner)
        console.warn(
          `Signer ${signerAddress} not owner of token ${tokenId} on ${origin}`,
        );
      return _super.transfer.call(
        this,
        origin,
        destination,
        recipient,
        tokenId,
      );
    });
  }
}
exports.HypERC721App = HypERC721App;
//# sourceMappingURL=app.js.map
