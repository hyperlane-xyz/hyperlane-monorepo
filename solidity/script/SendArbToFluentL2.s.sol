// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.22;

import {HypNative} from "../contracts/token/HypNative.sol";
import {TypeCasts} from "../contracts/libs/TypeCasts.sol";

import "forge-std/Script.sol";

/// @dev Sends a test native-ETH transfer through the Arb Sepolia HypNative
///      warp route, addressed to a Fluent L2 recipient. The L1FluentHypNative
///      on Sepolia auto-forwards the inbound to L2 via L1HypNativeGateway.
///
///      Recipient is encoded with `TypeCasts.addressToBytes32` (low-20-bytes
///      convention) to avoid the `cast --to-bytes32` right-padding pitfall.
///
///      Run:
///        forge script solidity/script/SendArbToFluentL2.s.sol:SendArbToFluentL2Script \
///          --rpc-url $(arbsepolia) --account <name> --sender <addr> --broadcast
contract SendArbToFluentL2Script is Script {
    using TypeCasts for address;

    // HypNative on Arb Sepolia.
    address internal constant WARP_ROUTE =
        0xC5790c39284BBd0a0707c553fE6d782948c11ED8;
    // Sepolia mailbox domain — L1FluentHypNative auto-forwards to Fluent L2.
    uint32 internal constant DESTINATION = 11155111;
    uint256 internal constant SEND_AMOUNT = 0.0001 ether;
    address internal constant L2_RECIPIENT =
        0x18FA4399b515F436E213AF5E5aD3337EbCb6E717;

    function run() public {
        bytes32 recipient32 = L2_RECIPIENT.addressToBytes32();
        uint256 gasFee = HypNative(payable(WARP_ROUTE)).quoteGasPayment(
            DESTINATION
        );
        uint256 totalValue = SEND_AMOUNT + gasFee;

        console.log("amount    :", SEND_AMOUNT);
        console.log("gasFee    :", gasFee);
        console.log("totalValue:", totalValue);
        console.log("recipient :", L2_RECIPIENT);

        vm.startBroadcast();
        bytes32 messageId = HypNative(payable(WARP_ROUTE)).transferRemote{
            value: totalValue
        }(DESTINATION, recipient32, SEND_AMOUNT);
        vm.stopBroadcast();

        console.log("messageId :");
        console.logBytes32(messageId);
        console.log("Track at  : https://explorer.hyperlane.xyz/message/");
    }
}
