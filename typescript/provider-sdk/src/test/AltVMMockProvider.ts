import * as AltVM from '../altvm.js';

type MockTransaction = any;

export class MockProvider implements AltVM.IProvider {
  static async connect(): Promise<MockProvider> {
    return new MockProvider();
  }

  // ### QUERY BASE ###

  async isHealthy(): Promise<boolean> {
    throw new Error(`not implemented`);
  }

  getRpcUrls(): string[] {
    throw new Error(`not implemented`);
  }

  async getHeight(): Promise<number> {
    throw new Error(`not implemented`);
  }

  async getBalance(_req: AltVM.ReqGetBalance): Promise<bigint> {
    throw new Error(`not implemented`);
  }

  async getTotalSupply(_req: AltVM.ReqGetTotalSupply): Promise<bigint> {
    throw new Error(`not implemented`);
  }

  async estimateTransactionFee(
    _req: AltVM.ReqEstimateTransactionFee<MockTransaction>,
  ): Promise<AltVM.ResEstimateTransactionFee> {
    throw new Error(`not implemented`);
  }

  // ### QUERY CORE ###

  async isMessageDelivered(
    _req: AltVM.ReqIsMessageDelivered,
  ): Promise<boolean> {
    throw new Error(`not implemented`);
  }

  // ### QUERY WARP ###

  async getToken(_req: AltVM.ReqGetToken): Promise<AltVM.ResGetToken> {
    throw new Error(`not implemented`);
  }

  async getRemoteRouters(
    _req: AltVM.ReqGetRemoteRouters,
  ): Promise<AltVM.ResGetRemoteRouters> {
    throw new Error(`not implemented`);
  }

  async getBridgedSupply(_req: AltVM.ReqGetBridgedSupply): Promise<bigint> {
    throw new Error(`not implemented`);
  }

  async quoteRemoteTransfer(
    _req: AltVM.ReqQuoteRemoteTransfer,
  ): Promise<AltVM.ResQuoteRemoteTransfer> {
    throw new Error(`not implemented`);
  }
}
