import { ethers } from 'ethers';

export type OFTAdapterParams = {
  bridges: { [chain: string]: string };
  providerForChain: (chain: string) => ethers.providers.Provider;
  signerForChain: (chain: string) => ethers.Signer;
};

const ITokenBridgeAbi = [
  'function quoteTransferRemote(uint32 destination, bytes32 recipient, uint256 amount) view returns (tuple(address token, uint256 amount)[])',
  'function transferRemote(uint32 destination, bytes32 recipient, uint256 amount) payable returns (bytes32)',
];

export class OftBridgeAdapter {
  constructor(private params: OFTAdapterParams) {}

  async quoteTransferRemote(
    chain: string,
    destination: number,
    recipient: string,
    amount: string,
  ) {
    const bridgeAddress = this.params.bridges[chain];
    const provider = this.params.providerForChain(chain);
    const contract = new ethers.Contract(
      bridgeAddress,
      ITokenBridgeAbi,
      provider,
    );
    const quotes = await contract.quoteTransferRemote(
      destination,
      recipient,
      amount,
    );
    return quotes;
  }

  async transferRemote(
    chain: string,
    destination: number,
    recipient: string,
    amount: string,
    valueWei?: string,
  ) {
    const bridgeAddress = this.params.bridges[chain];
    const signer = this.params.signerForChain(chain);
    const contract = new ethers.Contract(
      bridgeAddress,
      ITokenBridgeAbi,
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
