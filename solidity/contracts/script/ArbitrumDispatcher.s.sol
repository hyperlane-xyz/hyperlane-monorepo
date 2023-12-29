// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.0;

import {Script} from "forge-std/Script.sol";
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {StandardHookMetadata} from "../../contracts/hooks/libs/StandardHookMetadata.sol";
import {IMailbox} from "../../contracts/interfaces/IMailbox.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {ArbitrumOrbitIsm} from "../../contracts/isms/hook/ArbitrumOrbitIsm.sol";
import {ArbitrumOrbitHook} from "../../contracts/hooks/ArbitrumOrbitHook.sol";
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";

/// @dev Given the hook and ISM are deployed, you can write their addresses as constants in this script,
/// and run it to set the hook on the ISM and dispatch a message to the hook.
contract ArbitrumDispatcher is Script {
    uint256 private sk = vm.deriveKey(vm.envString("SEEDPHRASE"), 0);
    // TODO: fill in an address.
    address private sender = address(0);
    TestRecipient private testRecipient;

    // ========== CONSTANTS ==========

    uint256 private constant TEST_MSG_VALUE = 0.001e18;
    uint256 private MAX_FEE_PER_GAS = 0.15e9;
    bytes private constant TEST_MESSAGE =
        abi.encodePacked("Hello from the other chain!");
    uint256 private GAS_LIMIT = 5_000_000;
    // https://chainlist.org/?chain=1&search=arbitrum&testnets=true
    uint32 private constant ARBITRUM_DOMAIN = 421614;
    // https://docs.hyperlane.xyz/docs/reference/contract-addresses.
    address private constant MAILBOX =
        0xfFAEF09B3cd11D9b20d1a19bECca54EEC2884766;
    address private constant ARBHOOK =
        0x372173864A18758689940095fd6968C7270b9D84;
    address private constant ARBISM =
        0x89F65527b3970C6D08D0cB771E45692C96F48A46;

    function _dispatch() private {
        vm.createSelectFork("sepolia");
        vm.startBroadcast(sk);
        bytes memory metadata = StandardHookMetadata.formatMetadata(
            TEST_MSG_VALUE,
            GAS_LIMIT,
            sender,
            abi.encodePacked(MAX_FEE_PER_GAS)
        );
        uint256 deposit = ArbitrumOrbitHook(ARBHOOK).quoteDispatch(
            metadata,
            TEST_MESSAGE
        );
        IMailbox(MAILBOX).dispatch{
            value: deposit + MAX_FEE_PER_GAS * GAS_LIMIT
        }(
            ARBITRUM_DOMAIN,
            TypeCasts.addressToBytes32(address(testRecipient)),
            TEST_MESSAGE,
            metadata,
            ArbitrumOrbitHook(ARBHOOK)
        );
        vm.stopBroadcast();
    }

    function run() external {
        vm.createSelectFork("sepolia_arb");
        vm.startBroadcast(sk);
        testRecipient = new TestRecipient();
        ArbitrumOrbitIsm(ARBISM).setAuthorizedHook(
            TypeCasts.addressToBytes32(ARBHOOK)
        );
        vm.stopBroadcast();
        _dispatch();
    }
}
