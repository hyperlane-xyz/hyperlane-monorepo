import { Address } from '@hyperlane-xyz/utils';

import { BaseCosmWasmAdapter } from '../../app/MultiProtocolApp';
import { OwnerResponse, QueryMsg } from '../../cw-types/Igp.types';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider';
import { ChainName } from '../../types';

// TODO: import more
type IgpResponse = OwnerResponse;

export class CosmWasmIgpAdapter extends BaseCosmWasmAdapter {
  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider<any>,
    public readonly addresses: { mailbox: Address },
  ) {
    super(chainName, multiProvider, addresses);
  }

  async queryIgp<R extends IgpResponse>(msg: QueryMsg): Promise<R> {
    const provider = await this.getProvider();
    const response: R = await provider.queryContractSmart(
      this.addresses.mailbox,
      msg,
    );
    return response;
  }

  async owner(): Promise<string> {
    const response = await this.queryIgp<OwnerResponse>({
      ownable: {
        get_owner: {},
      },
    });
    return response.owner;
  }
}
