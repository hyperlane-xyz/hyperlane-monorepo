// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Script, console} from "forge-std/Script.sol";
import {TypeCasts} from "../contracts/libs/TypeCasts.sol";
import {Message} from "../contracts/libs/Message.sol";
import {TokenMessage} from "../contracts/token/libs/TokenMessage.sol";
import {Quote} from "../contracts/interfaces/ITokenBridge.sol";
import {IMailbox} from "../contracts/interfaces/IMailbox.sol";
import {IPostDispatchHook} from "../contracts/interfaces/hooks/IPostDispatchHook.sol";
import {OpL2NativeTokenBridge, OpL1V1NativeTokenBridge} from "../contracts/token/extensions/OPL2ToL1TokenBridgeNative.sol";
import {OPL2ToL1CcipReadIsm} from "../contracts/isms/hook/OPL2ToL1CcipReadIsm.sol";
import {StaticAggregationHookFactory} from "../contracts/hooks/aggregation/StaticAggregationHookFactory.sol";
import {StaticAggregationHook} from "../contracts/hooks/aggregation/StaticAggregationHook.sol";

contract TokenBridgeScript is Script {
    using TypeCasts for address;
    // using Message for bytes;
    using TokenMessage for bytes;

    uint256 L2_DOMAIN = vm.envUint("L2_DOMAIN");
    uint256 L1_DOMAIN = vm.envUint("L1_DOMAIN");
    uint256 PORTAL_VERSION = vm.envUint("L1_PORTAL_VERSION");

    // --------------------- Origin ---------------------
    StaticAggregationHookFactory factory =
        StaticAggregationHookFactory(
            vm.envAddress("L2_STATIC_AGGREGATION_HOOK_FACTORY")
        );
    address mailboxOrigin = vm.envAddress("L2_MAILBOX");
    address igpOrigin = vm.envAddress("L2_IGP");
    address l2Bridge = vm.envAddress("L2_BRIDGE");

    uint32 origin = uint32(L2_DOMAIN);
    uint32 destination = uint32(L1_DOMAIN);
    uint32 portalVersion = uint32(PORTAL_VERSION);

    // ------------------- Destination -------------------
    address mailboxDestination = vm.envAddress("L1_MAILBOX");
    address opPortal = vm.envAddress("L1_PORTAL");

    string[] urls = vm.envString("CCIP_READ_URLS", ",");

    function run() public {
        uint256 amount = 0.000001337 ether;
        bytes32 recipient = msg.sender.addressToBytes32();

        uint256 l2 = vm.createSelectFork(vm.envString("L2_RPC_URL"));
        OpL2NativeTokenBridge l2Vtb = new OpL2NativeTokenBridge(
            mailboxOrigin,
            l2Bridge
        );

        uint256 l1 = vm.createSelectFork(vm.envString("L1_RPC_URL"));
        OpL1V1NativeTokenBridge l1Vtb = new OpL1V1NativeTokenBridge(
            mailboxDestination,
            opPortal,
            urls
        );
        l1Vtb.enrollRemoteRouter(origin, address(l2Vtb).addressToBytes32());

        vm.selectFork(l2);
        l2Vtb.enrollRemoteRouter(
            destination,
            address(l1Vtb).addressToBytes32()
        );

        Quote[] memory quotes = l2Vtb.quoteTransferRemote(
            destination,
            recipient,
            amount
        );
        assert(quotes[0].token == address(0));

        bytes32 messageId = l2Vtb.transferRemote{value: quotes[0].amount}(
            destination,
            recipient,
            amount
        );

        console.log("messageId");
        console.logBytes32(messageId);
    }
}
