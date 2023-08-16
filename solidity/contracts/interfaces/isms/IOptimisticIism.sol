// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IInterchainSecurityModule} from "../IInterchainSecurityModule.sol";

interface IOptimisticIsm is IInterchainSecurityModule {
    /**
     * @dev _message is verified first and, after the fraud window has elapsed, then delivered
     * @notice Returns the ISM responsible for verifying _message
     * @dev Can change based on the content of _message
     * @param _message Formatted Hyperlane message (see Message.sol)
     * @return module The ISM to use to verify _message
     */
    function preVerify(bytes calldata _metadata, bytes calldata _message) 
        external 
        returns (bool);

    function markFraudulent(address _submodule) 
        external;
    
    function submodule(bytes calldata _message) 
        external 
        view 
        returns (IInterchainSecurityModule);
}
