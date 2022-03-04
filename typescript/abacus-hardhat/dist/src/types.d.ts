import { ethers } from 'ethers';
import { abacus, types } from '@abacus-network/abacus-deploy';
import "hardhat/types/runtime";
declare module 'hardhat/types/runtime' {
    interface HardhatRuntimeEnvironment {
        abacus: HardhatAbacusHelpers;
    }
}
export interface HardhatAbacusHelpers {
    deploy: (domains: types.Domain[], signer: ethers.Signer) => Promise<abacus.CoreDeploy>;
}
//# sourceMappingURL=types.d.ts.map