// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.0;

import {Script} from "forge-std/Script.sol";
import {ArbitrumOrbitHook} from "../../contracts/hooks/ArbitrumOrbitHook.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";

/// @dev Deploys the hook.
contract ArbitrumL1Deployer is Script {
    // https://docs.arbitrum.io/for-devs/useful-addresses
    address private constant L1_INBOX =
        0xaAe29B0366299461418F5324a79Afc425BE5ae21;
    // From https://docs.hyperlane.xyz/docs/reference/contract-addresses.
    address private constant MAILBOX =
        0xfFAEF09B3cd11D9b20d1a19bECca54EEC2884766;
    address private constant IGP = 0x6f2756380FD49228ae25Aa7F2817993cB74Ecc56;
    uint32 private constant ARBITRUM_ONE_DOMAIN = 421614;

    function run() external {
        vm.createSelectFork("sepolia");
        string memory seed = vm.envString("SEEDPHRASE");
        vm.startBroadcast(vm.deriveKey(seed, 0));
        address arbISM = vm.envAddress("ARB_ISM");
        new ArbitrumOrbitHook(
            L1_INBOX,
            ARBITRUM_ONE_DOMAIN,
            TypeCasts.addressToBytes32(arbISM),
            L1_INBOX,
            IGP
        );
        vm.stopBroadcast();
    }
}
