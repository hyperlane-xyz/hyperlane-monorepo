// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;
import {StaticAddressSetFactory} from "../../libs/StaticAddressSetFactory.sol";
import {StaticOptimisticIsm} from "./StaticOptimisticIsm.sol";

contract StaticOptimisticIsmFactory is StaticAddressSetFactory {
    function _deployImplementation() internal override returns (address) {
        return address(new StaticOptimisticIsm());
    }
}
