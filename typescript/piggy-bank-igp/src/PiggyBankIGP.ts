import { Contract, Signer, providers, BigNumber, utils } from 'ethers';

const PiggyBankIGPABI = [
  "function deposit() external payable",
  "function withdraw(uint256 amount) external",
  "function setSponsor(bytes32 sender) external",
  "function unsetSponsor(bytes32 sender) external",
  "function sponsorBalances(address) external view returns (uint256)",
  "function senderToSponsor(bytes32) external view returns (address)",
  "function innerIGP() external view returns (address)",
  "function hookType() external pure returns (uint8)"
];

export class PiggyBankIGPAdapter {
  public contract: Contract;

  constructor(address: string, providerOrSigner: providers.Provider | Signer) {
    this.contract = new Contract(address, PiggyBankIGPABI, providerOrSigner);
  }

  async deposit(amount: BigNumber): Promise<providers.TransactionResponse> {
    return this.contract.deposit({ value: amount });
  }

  async withdraw(amount: BigNumber): Promise<providers.TransactionResponse> {
    return this.contract.withdraw(amount);
  }

  async setSponsor(senderAddress: string): Promise<providers.TransactionResponse> {
    const paddedSender = utils.hexZeroPad(senderAddress, 32);
    return this.contract.setSponsor(paddedSender);
  }

  async unsetSponsor(senderAddress: string): Promise<providers.TransactionResponse> {
    const paddedSender = utils.hexZeroPad(senderAddress, 32);
    return this.contract.unsetSponsor(paddedSender);
  }

  async getSponsorBalance(sponsorAddress: string): Promise<BigNumber> {
    return this.contract.sponsorBalances(sponsorAddress);
  }

  async getSenderSponsor(senderAddress: string): Promise<string> {
    const paddedSender = utils.hexZeroPad(senderAddress, 32);
    return this.contract.senderToSponsor(paddedSender);
  }

  async getInnerIGP(): Promise<string> {
    return this.contract.innerIGP();
  }
}
