// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {IInterchainSecurityModule} from "../interfaces/IInterchainSecurityModule.sol";

contract TestIsm is IInterchainSecurityModule {
    uint8 public moduleType = uint8(Types.NULL);

    bool verifyResult = true;

    function setVerify(bool _verify) public {
        verifyResult = _verify;
    }

    function verify(bytes calldata, bytes calldata) public view returns (bool) {
        return verifyResult;
    }
}
