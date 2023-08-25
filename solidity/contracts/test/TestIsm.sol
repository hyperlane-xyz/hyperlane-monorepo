// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {IInterchainSecurityModule} from "../interfaces/IInterchainSecurityModule.sol";

contract TestIsm is IInterchainSecurityModule {
    uint8 public moduleType = uint8(Types.NULL);

    function verify(bytes calldata, bytes calldata) public pure returns (bool) {
        return true;
    }
}
