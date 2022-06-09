import { AbacusApp, ChainName, ChainNameToDomainId } from '@abacus-network/sdk';
import { ethers } from 'ethers';
import { HelloWorldContracts } from './contracts';

export class HelloWorldApp<
  Chain extends ChainName = ChainName,
> extends AbacusApp<HelloWorldContracts, Chain> {
  async sendHelloWorld(
    from: Chain,
    to: Chain,
    message: string,
  ): Promise<ethers.ContractReceipt> {
    const helloWorldContract = this.getContracts(from).router;
    const toDomain = ChainNameToDomainId[to];
    const tx = await helloWorldContract.sendHelloWorld(toDomain, message);
    return tx.wait();
  }
}
