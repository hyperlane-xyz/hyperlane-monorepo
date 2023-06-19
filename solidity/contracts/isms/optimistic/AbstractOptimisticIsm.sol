// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {IOptimisticIsm} from "../../interfaces/isms/IOptimisticIsm.sol";

/**
 * @title OptimisticIsm
 */
abstract contract AbstractOptimisticIsm is IOptimisticIsm {
    // ============ Constants ============

    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.OPTIMISTIC);

    // ============ Virtual Functions ============
    // ======= OVERRIDE THESE TO IMPLEMENT =======

    /**
     * @notice Returns the ISM responsible for verifying _message
     * @dev Can be copnfigured by the owner of the OptimisticISM
     * @param _message Formatted Hyperlane message (see Message.sol).
     * @return module The ISM to use to verify _message
     */
    function submodule(
        bytes calldata _message
    ) public view virtual returns (IInterchainSecurityModule);

    function isPreVerified() public view virtual returns (bool);

    // ============ Public Functions ============

    /**
     * @notice Sends _metadata and _message to the correct ISM
     * @param _metadata ABI encoded module metadata
     * @param _message Formatted Hyperlane message (see Message.sol).
     */
    function verify(
        bytes calldata _metadata,
        bytes calldata _message
    ) public returns (bool) {
        /**
         * The message has been pre-verified
         * The submodule used to pre-verify the message has not been flagged as compromised by m-of-n watchers
         * The fraud window has elapsed
         */
        require(isPreVerified(), "!pre-verified");
        return submodule(_message).verify(_metadata, _message); // call to submodule will check if marked as fraudulent
    }
}
