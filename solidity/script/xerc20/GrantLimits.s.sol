// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import "forge-std/Script.sol";

import {AnvilRPC} from "test/AnvilRPC.sol";

import {IXERC20Lockbox} from "@home/token/interfaces/IXERC20Lockbox.sol";
import {IXERC20} from "@home/token/interfaces/IXERC20.sol";
import {IERC20} from "@home/token/interfaces/IXERC20.sol";

// source .env.<CHAIN>
// anvil --fork-url $RPC_URL --port XXXX
// forge script GrantLimits.s.sol --broadcast --unlocked --rpc-url localhost:XXXX
contract GrantLimits is Script {
    address tester = 0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba;
    uint256 amount = 1 gwei;

    address router = vm.envAddress("ROUTER_ADDRESS");
    IERC20 erc20 = IERC20(vm.envAddress("ERC20_ADDRESS"));
    IXERC20 xerc20 = IXERC20(vm.envAddress("XERC20_ADDRESS"));

    function runFrom(address account) internal {
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
