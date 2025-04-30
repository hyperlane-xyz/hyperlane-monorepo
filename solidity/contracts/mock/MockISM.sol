// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IInterchainSecurityModule} from "../interfaces/IInterchainSecurityModule.sol"; // Adjust path if needed

contract MockISM is IInterchainSecurityModule {
    function moduleType() external view override returns (uint8) {
        return uint8(Types.UNUSED); // Or any appropriate type, doesn't matter much for mock
    }

    function verify(
        bytes calldata _metadata,
        bytes calldata _message
    ) external override returns (bool) {
        // For a basic mock, always return true.
        // In a real scenario, this would contain verification logic.
        return true;
    }
}
