// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {MerkleTreeHook} from "../hooks/MerkleTreeHook.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";

/**
 * @title TronMerkleTreeHook
 * @notice Tron-specific MerkleTreeHook implementation
 * @dev Adapts the MerkleTreeHook for Tron's block structure and gas model
 */
contract TronMerkleTreeHook is MerkleTreeHook {
    /**
     * @notice Constructor
     * @param _mailbox The address of the mailbox contract
     * @param _ism The address of the interchain security module
     */
    constructor(address _mailbox, address _ism) MerkleTreeHook(_mailbox, _ism) {}

    /**
     * @notice Returns the hook type
     * @return Hook type
     */
    function hookType() external pure override returns (uint8) {
        return uint8(IPostDispatchHook.HookTypes.MERKLE_TREE);
    }

    /**
     * @notice Tron-specific gas estimation
     * @dev Tron has different gas costs than Ethereum
     */
    function _estimateGas() internal pure override returns (uint256) {
        // Tron gas costs are different, adjust accordingly
        // This is a placeholder - actual values should be calibrated
        return 100000; // Adjusted for Tron
    }
}
