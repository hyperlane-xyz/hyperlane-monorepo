// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IInterchainSecurityModule} from "../interfaces/IInterchainSecurityModule.sol";
import {PackageVersioned} from "@home/PackageVersioned.sol";

contract NoopIsm is IInterchainSecurityModule, PackageVersioned {
    uint8 public constant override moduleType = uint8(Types.NULL);

    function verify(
        bytes calldata,
        bytes calldata
    ) public pure override returns (bool) {
        return true;
    }
}
