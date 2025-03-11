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
exports.SigningHyperlaneModuleClient = exports.HyperlaneModuleClient = void 0;
const stargate_1 = require('@cosmjs/stargate');
const math_1 = require('@cosmjs/math');
const tendermint_rpc_1 = require('@cosmjs/tendermint-rpc');
const query_1 = require('./hyperlane/warp/query');
const query_2 = require('./hyperlane/core/query');
const registry_1 = require('./registry');
const aminomessages_1 = require('./hyperlane/core/aminomessages');
const aminomessages_2 = require('./hyperlane/warp/aminomessages');
const aminomessages_3 = require('./hyperlane/interchain_security/aminomessages');
const aminomessages_4 = require('./hyperlane/post_dispatch/aminomessages');
const amino_1 = require('@cosmjs/amino');
const query_3 = require('./hyperlane/interchain_security/query');
const query_4 = require('./hyperlane/post_dispatch/query');
class HyperlaneModuleClient extends stargate_1.StargateClient {
  constructor(cometClient, options) {
    super(cometClient, options);
    this.query = stargate_1.QueryClient.withExtensions(
      cometClient,
      stargate_1.setupBankExtension,
      query_2.setupCoreExtension,
      query_3.setupInterchainSecurityExtension,
      query_4.setupPostDispatchExtension,
      query_1.setupWarpExtension,
    );
  }
  static connect(endpoint_1) {
    return __awaiter(
      this,
      arguments,
      void 0,
      function* (endpoint, options = {}) {
        const client = yield (0, tendermint_rpc_1.connectComet)(endpoint);
        return new HyperlaneModuleClient(client, options);
      },
    );
  }
  simulate(signerAddress, messages, memo) {
    return __awaiter(this, void 0, void 0, function* () {
      var _a;
      const queryClient = this.getQueryClient();
      const signer = (0, amino_1.decodeBech32Pubkey)(signerAddress);
      const { sequence } = yield this.getSequence(signerAddress);
      const { gasInfo } = yield queryClient.tx.simulate(
        messages,
        memo,
        signer,
        sequence,
      );
      return math_1.Uint53.fromString(
        (_a =
          gasInfo === null || gasInfo === void 0
            ? void 0
            : gasInfo.gasUsed.toString()) !== null && _a !== void 0
          ? _a
          : '0',
      ).toNumber();
    });
  }
}
exports.HyperlaneModuleClient = HyperlaneModuleClient;
class SigningHyperlaneModuleClient extends stargate_1.SigningStargateClient {
  constructor(cometClient, signer, account, options) {
    super(
      cometClient,
      signer,
      Object.assign(Object.assign({}, options), {
        aminoTypes: new stargate_1.AminoTypes(
          Object.assign(
            Object.assign(
              Object.assign(
                Object.assign(
                  Object.assign({}, options.aminoTypes),
                  (0, aminomessages_1.createCoreAminoConverter)(),
                ),
                (0, aminomessages_3.createInterchainSecurityAminoConverter)(),
              ),
              (0, aminomessages_4.createPostDispatchAminoConverter)(),
            ),
            (0, aminomessages_2.createWarpAminoConverter)(),
          ),
        ),
      }),
    );
    this.GAS_MULTIPLIER = 1.6;
    this.query = stargate_1.QueryClient.withExtensions(
      cometClient,
      stargate_1.setupBankExtension,
      query_2.setupCoreExtension,
      query_3.setupInterchainSecurityExtension,
      query_4.setupPostDispatchExtension,
      query_1.setupWarpExtension,
    );
    // register all the custom tx types
    for (const typeUrl in registry_1.REGISTRY) {
      const type = registry_1.REGISTRY[typeUrl];
      this.registry.register(typeUrl, type);
    }
    this.account = account;
  }
  static connectWithSigner(endpoint_1, signer_1) {
    return __awaiter(
      this,
      arguments,
      void 0,
      function* (endpoint, signer, options = {}) {
        const client = yield (0, tendermint_rpc_1.connectComet)(endpoint);
        const [account] = yield signer.getAccounts();
        return new SigningHyperlaneModuleClient(
          client,
          signer,
          account,
          options,
        );
      },
    );
  }
  signTx(msg, options) {
    return __awaiter(this, void 0, void 0, function* () {
      var _a;
      const result = yield this.signAndBroadcast(
        this.account.address,
        [msg],
        (_a = options === null || options === void 0 ? void 0 : options.fee) !==
          null && _a !== void 0
          ? _a
          : this.GAS_MULTIPLIER,
        options === null || options === void 0 ? void 0 : options.memo,
      );
      (0, stargate_1.assertIsDeliverTxSuccess)(result);
      return result;
    });
  }
  createMailbox(value, options) {
    return __awaiter(this, void 0, void 0, function* () {
      const msg = {
        typeUrl: '/hyperlane.core.v1.MsgCreateMailbox',
        value: Object.assign({ owner: this.account.address }, value),
      };
      return this.signTx(msg, options);
    });
  }
  setMailbox(value, options) {
    return __awaiter(this, void 0, void 0, function* () {
      const msg = {
        typeUrl: '/hyperlane.core.v1.MsgSetMailbox',
        value: Object.assign({ owner: this.account.address }, value),
      };
      return this.signTx(msg, options);
    });
  }
  processMessage(value, options) {
    return __awaiter(this, void 0, void 0, function* () {
      const msg = {
        typeUrl: '/hyperlane.core.v1.MsgProcessMessage',
        value: Object.assign({ relayer: this.account.address }, value),
      };
      return this.signTx(msg, options);
    });
  }
  createMessageIdMultisigIsm(value, options) {
    return __awaiter(this, void 0, void 0, function* () {
      const msg = {
        typeUrl: '/hyperlane.core.v1.MsgCreateMessageIdMultisigIsm',
        value: Object.assign({ creator: this.account.address }, value),
      };
      return this.signTx(msg, options);
    });
  }
  createMerklerootMultisigIsm(value, options) {
    return __awaiter(this, void 0, void 0, function* () {
      const msg = {
        typeUrl: '/hyperlane.core.v1.MsgCreateMerkleRootMultisigIsm',
        value: Object.assign({ creator: this.account.address }, value),
      };
      return this.signTx(msg, options);
    });
  }
  createNoopIsm(value, options) {
    return __awaiter(this, void 0, void 0, function* () {
      const msg = {
        typeUrl: '/hyperlane.core.v1.MsgCreateNoopIsm',
        value: Object.assign({ creator: this.account.address }, value),
      };
      return this.signTx(msg, options);
    });
  }
  announceValidator(value, options) {
    return __awaiter(this, void 0, void 0, function* () {
      const msg = {
        typeUrl: '/hyperlane.core.v1.MsgAnnounceValidator',
        value: Object.assign({ creator: this.account.address }, value),
      };
      return this.signTx(msg, options);
    });
  }
  createIgp(value, options) {
    return __awaiter(this, void 0, void 0, function* () {
      const msg = {
        typeUrl: '/hyperlane.core.v1.MsgCreateIgp',
        value: Object.assign({ owner: this.account.address }, value),
      };
      return this.signTx(msg, options);
    });
  }
  setIgpOwner(value, options) {
    return __awaiter(this, void 0, void 0, function* () {
      const msg = {
        typeUrl: '/hyperlane.core.v1.MsgSetIgpOwner',
        value: Object.assign({ owner: this.account.address }, value),
      };
      return this.signTx(msg, options);
    });
  }
  setDestinationGasConfig(value, options) {
    return __awaiter(this, void 0, void 0, function* () {
      const msg = {
        typeUrl: '/hyperlane.core.v1.MsgSetDestinationGasConfig',
        value: Object.assign({ owner: this.account.address }, value),
      };
      return this.signTx(msg, options);
    });
  }
  payForGas(value, options) {
    return __awaiter(this, void 0, void 0, function* () {
      const msg = {
        typeUrl: '/hyperlane.core.v1.MsgPayForGas',
        value: Object.assign({ sender: this.account.address }, value),
      };
      return this.signTx(msg, options);
    });
  }
  claim(value, options) {
    return __awaiter(this, void 0, void 0, function* () {
      const msg = {
        typeUrl: '/hyperlane.core.v1.MsgClaim',
        value: Object.assign({ sender: this.account.address }, value),
      };
      return this.signTx(msg, options);
    });
  }
  createMerkleTreeHook(value, options) {
    return __awaiter(this, void 0, void 0, function* () {
      const msg = {
        typeUrl: '/hyperlane.core.v1.MsgCreateMerkleTreeHook',
        value: Object.assign({ owner: this.account.address }, value),
      };
      return this.signTx(msg, options);
    });
  }
  createNoopHook(value, options) {
    return __awaiter(this, void 0, void 0, function* () {
      const msg = {
        typeUrl: '/hyperlane.core.v1.MsgCreateNoopHook',
        value: Object.assign({ owner: this.account.address }, value),
      };
      return this.signTx(msg, options);
    });
  }
  createCollateralToken(value, options) {
    return __awaiter(this, void 0, void 0, function* () {
      const msg = {
        typeUrl: '/hyperlane.warp.v1.MsgCreateCollateralToken',
        value: Object.assign({ owner: this.account.address }, value),
      };
      return this.signTx(msg, options);
    });
  }
  createSyntheticToken(value, options) {
    return __awaiter(this, void 0, void 0, function* () {
      const msg = {
        typeUrl: '/hyperlane.warp.v1.MsgCreateSyntheticToken',
        value: Object.assign({ owner: this.account.address }, value),
      };
      return this.signTx(msg, options);
    });
  }
  setToken(value, options) {
    return __awaiter(this, void 0, void 0, function* () {
      const msg = {
        typeUrl: '/hyperlane.warp.v1.MsgSetToken',
        value: Object.assign({ owner: this.account.address }, value),
      };
      return this.signTx(msg, options);
    });
  }
  enrollRemoteRouter(value, options) {
    return __awaiter(this, void 0, void 0, function* () {
      const msg = {
        typeUrl: '/hyperlane.warp.v1.MsgEnrollRemoteRouter',
        value: Object.assign({ owner: this.account.address }, value),
      };
      return this.signTx(msg, options);
    });
  }
  unrollRemoteRouter(value, options) {
    return __awaiter(this, void 0, void 0, function* () {
      const msg = {
        typeUrl: '/hyperlane.warp.v1.MsgUnrollRemoteRouter',
        value: Object.assign({ owner: this.account.address }, value),
      };
      return this.signTx(msg, options);
    });
  }
  remoteTransfer(value, options) {
    return __awaiter(this, void 0, void 0, function* () {
      const msg = {
        typeUrl: '/hyperlane.warp.v1.MsgRemoteTransfer',
        value: Object.assign({ sender: this.account.address }, value),
      };
      return this.signTx(msg, options);
    });
  }
}
exports.SigningHyperlaneModuleClient = SigningHyperlaneModuleClient;
//# sourceMappingURL=index.js.map
