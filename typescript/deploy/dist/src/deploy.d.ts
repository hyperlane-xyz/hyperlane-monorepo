import { ethers } from 'ethers';
import { types } from '@abacus-network/utils';
import { ChainName, NameOrDomain, MultiProvider, ProxiedAddress } from '@abacus-network/sdk';
import { VerificationInput } from './verify';
export declare class ProxiedContract<T extends ethers.Contract> {
    readonly contract: T;
    readonly addresses: ProxiedAddress;
    constructor(contract: T, addresses: ProxiedAddress);
    get address(): string;
}
export declare abstract class AbacusAppDeployer<T, C> extends MultiProvider {
    protected addresses: Map<number, T>;
    protected verification: Map<number, VerificationInput>;
    constructor();
    getAddresses(nameOrDomain: NameOrDomain): T | undefined;
    mustGetAddresses(nameOrDomain: NameOrDomain): T;
    getVerification(nameOrDomain: NameOrDomain): VerificationInput | undefined;
    mustGetVerification(nameOrDomain: NameOrDomain): VerificationInput;
    get addressesRecord(): Partial<Record<ChainName, T>>;
    addVerificationInput(nameOrDomain: NameOrDomain, input: VerificationInput): void;
    abstract deployContracts(domain: types.Domain, config: C): Promise<T>;
    deploy(config: C): Promise<void>;
    deployContract<L extends ethers.Contract>(nameOrDomain: NameOrDomain, contractName: string, factory: ethers.ContractFactory, ...args: any[]): Promise<L>;
    /**
     * Deploys the UpgradeBeacon, Implementation and Proxy for a given contract
     *
     * @param T - The contract
     */
    deployProxiedContract<L extends ethers.Contract>(nameOrDomain: NameOrDomain, contractName: string, factory: ethers.ContractFactory, ubcAddress: types.Address, deployArgs: any[], initArgs: any[]): Promise<ProxiedContract<L>>;
    /**
     * Sets up a new proxy with the same beacon and implementation
     *
     * @param T - The contract
     */
    duplicateProxiedContract<L extends ethers.Contract>(nameOrDomain: NameOrDomain, contractName: string, contract: ProxiedContract<L>, initArgs: any[]): Promise<ProxiedContract<L>>;
    ready(): Promise<void>;
    writeContracts(filepath: string): void;
    writeVerification(directory: string): void;
    static stringify(obj: Object): string;
    static write(filepath: string, contents: string): void;
    static writeJson(filepath: string, obj: Object): void;
}
//# sourceMappingURL=deploy.d.ts.map