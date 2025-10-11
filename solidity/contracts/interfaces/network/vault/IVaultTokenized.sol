// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IVault} from "./IVault.sol";

interface IVaultTokenized is IVault {
    /**
     * @notice Initial parameters needed for a tokenized vault deployment.
     * @param baseParams initial parameters needed for a vault deployment (InitParams)
     * @param name name for the ERC20 tokenized vault
     * @param symbol symbol for the ERC20 tokenized vault
     */
    struct InitParamsTokenized {
        InitParams baseParams;
        string name;
        string symbol;
    }
}
