import { types } from '@abacus-network/utils';
import { ChainName } from '@abacus-network/sdk';
import { ContractVerificationInput, VerificationInput } from './types';
export declare abstract class ContractVerifier {
    readonly key: string;
    constructor(key: string);
    abstract networks: ChainName[];
    abstract getVerificationInput(network: ChainName[]): VerificationInput;
    static etherscanLink(network: ChainName, address: types.Address): string;
    verify(hre: any): Promise<void>;
    verifyContract(network: ChainName, input: ContractVerificationInput, hre: any): Promise<void>;
    verifyProxy(network: ChainName, address: types.Address): Promise<void>;
}
//# sourceMappingURL=ContractVerifier.d.ts.map