import { ethers } from 'ethers';

export type LayerZeroDomainConfig = {
  lzChainId: number;
  dstVault: string;
  adapterParams: string;
};

export type LayerZeroBridgeConfig = {
  [hyperlaneDomain: number]: LayerZeroDomainConfig;
};

export type OFTAdapterParams = {
  domainConfig: LayerZeroBridgeConfig;
  bridges: { [chain: string]: string };
  providerForChain: (chain: string) => ethers.providers.Provider;
  signerForChain: (chain: string) => ethers.Signer;
};

const TokenBridgeOftAbi = [
  'function quoteTransferRemote(uint32 destinationDomain, bytes32 recipient, uint256 amountOut) view returns (tuple(address token, uint256 amount)[])',
  'function transferRemote(uint32 destinationDomain, bytes32 recipient, uint256 amountOut) payable returns (bytes32 transferId)',
];

export class OftBridgeAdapter {
  constructor(private params: OFTAdapterParams) {}

  async quoteTransferRemote(
    _destination: number,
    _recipient: string,
    _amount: string,
  ) {
    return [{ token: 'native', amount: '0' }];
  }

  async transferRemote(
    destination: number,
    recipient: string,
    amount: string,
    chain: string,
    valueWei?: string,
  ) {
    const bridgeAddress = this.params.bridges[chain];
    const signer = this.params.signerForChain(chain);
    const contract = new ethers.Contract(
      bridgeAddress,
      TokenBridgeOftAbi,
      signer,
    );
    const overrides = valueWei
      ? { value: ethers.BigNumber.from(valueWei) }
      : {};
    const tx = await contract.transferRemote(
      destination,
      recipient,
      amount,
      overrides,
    );
    const receipt = await tx.wait();
    return receipt?.transactionHash ?? tx.hash;
  }
}
