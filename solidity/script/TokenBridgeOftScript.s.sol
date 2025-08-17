/// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import "forge-std/Script.sol";
import {TokenBridgeOft} from "../contracts/token/TokenBridgeOft.sol";

contract TokenBridgeOftScript is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address erc20 = vm.envAddress("ERC20");
        uint256 scale = vm.envUint("SCALE");
        address mailbox = vm.envAddress("MAILBOX");
        address hook = vm.envAddress("HOOK");
        address ism = vm.envAddress("ISM");
        address owner = vm.envAddress("OWNER");

        vm.startBroadcast(pk);
        TokenBridgeOft oft = new TokenBridgeOft(erc20, scale, mailbox);
        oft.initialize(hook, ism, owner);
        vm.stopBroadcast();
    }
}
