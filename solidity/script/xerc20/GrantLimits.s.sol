// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import "forge-std/Vm.sol";
import "forge-std/Script.sol";

import {ForkScript} from "contracts/libs/ForkScript.sol";
import {AnvilRPC} from "contracts/libs/AnvilRPC.sol";

import {IXERC20Lockbox} from "contracts/token/interfaces/IXERC20Lockbox.sol";
import {IXERC20} from "contracts/token/interfaces/IXERC20.sol";
import {IERC20} from "contracts/token/interfaces/IXERC20.sol";
import {HypXERC20Lockbox} from "contracts/token/extensions/HypXERC20Lockbox.sol";
import {HypXERC20} from "contracts/token/extensions/HypXERC20.sol";

import {TypeCasts} from "contracts/libs/TypeCasts.sol";
import {TokenMessage} from "contracts/token/libs/TokenMessage.sol";

// anvil
// forge script ./script/xerc20/SetLimits.s.sol --broadcast --unlocked
contract GrantLimits is Script {
    address tester = 0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba;
    uint256 amount = 1 ether;

    address router = vm.envString("ROUTER_ADDRESS");
    IERC20 erc20 = IERC20(vm.envString("ERC20_ADDRESS"));
    IXERC20 xerc20 = IXERC20(vm.envString("XERC20_ADDRESS"));

    function runFrom(address account) {
        AnvilRPC.setBalance(account, 1 ether);
        AnvilRPC.impersonateAccount(account);
        vm.broadcast(account);
    }

    function run() external {
        address owner = xerc20.owner();
        runFrom(owner);
        xerc20.setLimits(router, amount, amount);

        runFrom(address(erc20));
        erc20.transfer(tester, amount);
    }
}
