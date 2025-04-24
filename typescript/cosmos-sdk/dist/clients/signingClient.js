import {
  AminoTypes,
  QueryClient,
  SigningStargateClient,
  assertIsDeliverTxSuccess,
  setupBankExtension,
} from '@cosmjs/stargate';
import { connectComet } from '@cosmjs/tendermint-rpc';

import { setupCoreExtension } from '../hyperlane/core/query.js';
import { setupInterchainSecurityExtension } from '../hyperlane/interchain_security/query.js';
import { setupPostDispatchExtension } from '../hyperlane/post_dispatch/query.js';
import { setupWarpExtension } from '../hyperlane/warp/query.js';
import { COSMOS_MODULE_MESSAGE_REGISTRY as R } from '../registry.js';

export class SigningHyperlaneModuleClient extends SigningStargateClient {
  query;
  account;
  GAS_MULTIPLIER = 1.6;
  constructor(cometClient, signer, account, options) {
    // register all the custom amino tx types
    const aminoTypes = Object.values(R)
      .filter((r) => !!r.amino?.type) // filter out tx responses which have no amino type
      .reduce(
        (types, { proto, amino }) => ({
          ...types,
          [proto.type]: {
            aminoType: amino?.type,
            toAmino: amino?.converter?.toJSON ?? proto.converter.toJSON,
            fromAmino: amino?.converter?.fromJSON ?? proto.converter.fromJSON,
          },
        }),
        {},
      );
    super(cometClient, signer, {
      ...options,
      aminoTypes: new AminoTypes({
        ...options.aminoTypes,
        ...aminoTypes,
      }),
    });
    this.query = QueryClient.withExtensions(
      cometClient,
      setupBankExtension,
      setupCoreExtension,
      setupInterchainSecurityExtension,
      setupPostDispatchExtension,
      setupWarpExtension,
    );
    // register all the custom tx types
    Object.values(R).forEach(({ proto }) => {
      this.registry.register(proto.type, proto.converter);
    });
    this.account = account;
  }
  static async connectWithSigner(endpoint, signer, options = {}) {
    const client = await connectComet(endpoint);
    const [account] = await signer.getAccounts();
    return new SigningHyperlaneModuleClient(client, signer, account, options);
  }
  static async createWithSigner(cometclient, signer, options = {}) {
    const [account] = await signer.getAccounts();
    return new SigningHyperlaneModuleClient(
      cometclient,
      signer,
      account,
      options,
    );
  }
  async submitTx(msg, options) {
    const result = await this.signAndBroadcast(
      this.account.address,
      [msg],
      options?.fee ?? this.GAS_MULTIPLIER,
      options?.memo,
    );
    assertIsDeliverTxSuccess(result);
    return {
      ...result,
      response: this.registry.decode(result.msgResponses[0]),
    };
  }
  async createMailbox(value, options) {
    const msg = {
      typeUrl: R.MsgCreateMailbox.proto.type,
      value: R.MsgCreateMailbox.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };
    return this.submitTx(msg, options);
  }
  async setMailbox(value, options) {
    const msg = {
      typeUrl: R.MsgSetMailbox.proto.type,
      value: R.MsgSetMailbox.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };
    return this.submitTx(msg, options);
  }
  async processMessage(value, options) {
    const msg = {
      typeUrl: R.MsgProcessMessage.proto.type,
      value: R.MsgProcessMessage.proto.converter.create({
        ...value,
        relayer: this.account.address,
      }),
    };
    return this.submitTx(msg, options);
  }
  async createMessageIdMultisigIsm(value, options) {
    const msg = {
      typeUrl: R.MsgCreateMessageIdMultisigIsm.proto.type,
      value: R.MsgCreateMessageIdMultisigIsm.proto.converter.create({
        ...value,
        creator: this.account.address,
      }),
    };
    return this.submitTx(msg, options);
  }
  async createMerkleRootMultisigIsm(value, options) {
    const msg = {
      typeUrl: R.MsgCreateMerkleRootMultisigIsm.proto.type,
      value: R.MsgCreateMerkleRootMultisigIsm.proto.converter.create({
        ...value,
        creator: this.account.address,
      }),
    };
    return this.submitTx(msg, options);
  }
  async createNoopIsm(value, options) {
    const msg = {
      typeUrl: R.MsgCreateNoopIsm.proto.type,
      value: R.MsgCreateNoopIsm.proto.converter.create({
        ...value,
        creator: this.account.address,
      }),
    };
    return this.submitTx(msg, options);
  }
  async announceValidator(value, options) {
    const msg = {
      typeUrl: R.MsgAnnounceValidator.proto.type,
      value: R.MsgAnnounceValidator.proto.converter.create({
        ...value,
        creator: this.account.address,
      }),
    };
    return this.submitTx(msg, options);
  }
  async createIgp(value, options) {
    const msg = {
      typeUrl: R.MsgCreateIgp.proto.type,
      value: R.MsgCreateIgp.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };
    return this.submitTx(msg, options);
  }
  async setIgpOwner(value, options) {
    const msg = {
      typeUrl: R.MsgSetIgpOwner.proto.type,
      value: R.MsgSetIgpOwner.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };
    return this.submitTx(msg, options);
  }
  async setDestinationGasConfig(value, options) {
    const msg = {
      typeUrl: R.MsgSetDestinationGasConfig.proto.type,
      value: R.MsgSetDestinationGasConfig.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };
    return this.submitTx(msg, options);
  }
  async payForGas(value, options) {
    const msg = {
      typeUrl: R.MsgPayForGas.proto.type,
      value: R.MsgPayForGas.proto.converter.create({
        ...value,
        sender: this.account.address,
      }),
    };
    return this.submitTx(msg, options);
  }
  async claim(value, options) {
    const msg = {
      typeUrl: R.MsgClaim.proto.type,
      value: R.MsgClaim.proto.converter.create({
        ...value,
        sender: this.account.address,
      }),
    };
    return this.submitTx(msg, options);
  }
  async createMerkleTreeHook(value, options) {
    const msg = {
      typeUrl: R.MsgCreateMerkleTreeHook.proto.type,
      value: R.MsgCreateMerkleTreeHook.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };
    return this.submitTx(msg, options);
  }
  async createNoopHook(value, options) {
    const msg = {
      typeUrl: R.MsgCreateNoopHook.proto.type,
      value: R.MsgCreateNoopHook.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };
    return this.submitTx(msg, options);
  }
  async createCollateralToken(value, options) {
    const msg = {
      typeUrl: R.MsgCreateCollateralToken.proto.type,
      value: R.MsgCreateCollateralToken.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };
    return this.submitTx(msg, options);
  }
  async createSyntheticToken(value, options) {
    const msg = {
      typeUrl: R.MsgCreateSyntheticToken.proto.type,
      value: R.MsgCreateSyntheticToken.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };
    return this.submitTx(msg, options);
  }
  async setToken(value, options) {
    const msg = {
      typeUrl: R.MsgSetToken.proto.type,
      value: R.MsgSetToken.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };
    return this.submitTx(msg, options);
  }
  async enrollRemoteRouter(value, options) {
    const msg = {
      typeUrl: R.MsgEnrollRemoteRouter.proto.type,
      value: R.MsgEnrollRemoteRouter.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };
    return this.submitTx(msg, options);
  }
  async unrollRemoteRouter(value, options) {
    const msg = {
      typeUrl: R.MsgUnrollRemoteRouter.proto.type,
      value: R.MsgUnrollRemoteRouter.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };
    return this.submitTx(msg, options);
  }
  async remoteTransfer(value, options) {
    const msg = {
      typeUrl: R.MsgRemoteTransfer.proto.type,
      value: R.MsgRemoteTransfer.proto.converter.create({
        ...value,
        sender: this.account.address,
      }),
    };
    return this.submitTx(msg, options);
  }
}
//# sourceMappingURL=signingClient.js.map
