// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Script, console} from "forge-std/Script.sol";
import {TypeCasts} from "../contracts/libs/TypeCasts.sol";
import {Message} from "../contracts/libs/Message.sol";
import {TokenMessage} from "../contracts/token/libs/TokenMessage.sol";
import {Quote} from "../contracts/interfaces/ITokenBridge.sol";
import {IMailbox} from "../contracts/interfaces/IMailbox.sol";
import {IPostDispatchHook} from "../contracts/interfaces/hooks/IPostDispatchHook.sol";
import {OPL2ToL1TokenBridgeNative} from "../contracts/token/extensions/OPL2ToL1TokenBridgeNative.sol";
import {OPL2ToL1CcipReadHook} from "../contracts/hooks/OPL2ToL1CcipReadHook.sol";
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

    event MessagePassed(
        uint256 indexed nonce,
        address indexed sender,
        address indexed target,
        uint256 value,
        uint256 gasLimit,
        bytes data,
        bytes32 withdrawalHash
    );

    function setHook(address payable vtb, address hook) public {
        vm.startBroadcast();
        OPL2ToL1TokenBridgeNative(vtb).setHook(hook);
        vm.stopBroadcast();
    }

    function setIsm(address payable vtb, address ism) public {
        vm.startBroadcast();
        OPL2ToL1TokenBridgeNative(vtb).setInterchainSecurityModule(ism);
        vm.stopBroadcast();
    }

    function deployTokenBridge(
        address _l2Bridge,
        address _mailbox
    ) public returns (address) {
        vm.startBroadcast();
        uint256 scale = 1;
        OPL2ToL1TokenBridgeNative vtb = new OPL2ToL1TokenBridgeNative(
            scale,
            _mailbox,
            destination,
            _l2Bridge
        );
        console.log("TokenBridgeNative @", address(vtb));
        vm.stopBroadcast();

        return address(vtb);
    }

    function deployHook(
        address proveWithdrawalIsm,
        address igp
    ) public returns (address hook) {
        vm.startBroadcast();
        address[] memory hooks = new address[](2);
        hooks[0] = address(
            new OPL2ToL1CcipReadHook(
                IMailbox(mailboxOrigin),
                proveWithdrawalIsm,
                IPostDispatchHook(address(0))
            )
        );

        hooks[1] = igp;

        hook = address(StaticAggregationHook(factory.deploy(hooks)));

        vm.stopBroadcast();
    }

    function enrollRouter(
        address payable vtb,
        uint32 domain,
        address router
    ) public {
        vm.startBroadcast();
        OPL2ToL1TokenBridgeNative(vtb).enrollRemoteRouter(
            domain,
            router.addressToBytes32()
        );
        vm.stopBroadcast();
    }

    function deployIsm() public returns (address) {
        vm.startBroadcast();
        OPL2ToL1CcipReadIsm ism = new OPL2ToL1CcipReadIsm(
            urls,
            opPortal,
            portalVersion,
            mailboxDestination
        );
        console.log("OPL2ToL1CcipReadIsm @", address(ism));

        vm.stopBroadcast();
        return address(ism);
    }

    function deployDestination()
        public
        returns (OPL2ToL1TokenBridgeNative vtb)
    {
        vm.startBroadcast();
        uint256 scale = 1;
        vtb = new OPL2ToL1TokenBridgeNative(
            scale,
            mailboxDestination,
            destination,
            address(0)
        );
        console.log("TokenBridgeNative @", address(vtb));
        vm.stopBroadcast();
    }

    function transferRemote(
        address payable _vtb,
        uint32 _destination,
        address _recipient,
        uint256 amount
    ) public returns (bytes32 messageId) {
        vm.startBroadcast();
        OPL2ToL1TokenBridgeNative vtb = OPL2ToL1TokenBridgeNative(_vtb);
        bytes32 recipient = _recipient.addressToBytes32();
        Quote[] memory quotes = vtb.quoteTransferRemote(
            destination,
            recipient,
            amount
        );

        messageId = vtb.transferRemote{value: amount + quotes[0].amount}(
            _destination,
            recipient,
            amount
        );

        console.log("messageId");
        console.logBytes32(messageId);
        vm.stopBroadcast();
    }

    function run() public {
        address recipient = msg.sender;
        uint256 amount = 0.000001337 ether;

        address remoteVtb = vm.addr(1);
        address ism = vm.addr(2);
        (address payable vtb, address hook) = deployAllOrigin(remoteVtb, ism);

        Quote[] memory quotes = OPL2ToL1TokenBridgeNative(vtb)
            .quoteTransferRemote(
                destination,
                recipient.addressToBytes32(),
                amount
            );

        bytes32 messageId = transferRemote(
            payable(vtb),
            destination,
            recipient,
            amount
        );

        console.log("messageId");
        console.logBytes32(messageId);
    }

    function deployAllOrigin(
        address remoteRouter,
        address proveWithdrawalIsm
    ) public returns (address payable vtb, address hook) {
        vtb = payable(deployTokenBridge(l2Bridge, mailboxOrigin));
        enrollRouter(vtb, destination, remoteRouter);
        hook = deployHook(proveWithdrawalIsm, igpOrigin);

        vm.startBroadcast();
        OPL2ToL1TokenBridgeNative(vtb).setHook(hook);
        vm.stopBroadcast();

        console.log("vtb @ ", vtb);
        console.log("hook @ ", hook);
    }

    function deployAllDestination()
        public
        returns (address payable vtb, address ism)
    {
        vtb = payable(deployTokenBridge(address(0), mailboxDestination));
        ism = deployIsm();

        vm.startBroadcast();
        OPL2ToL1TokenBridgeNative(vtb).setInterchainSecurityModule(ism);
        vm.stopBroadcast();

        console.log("vtb @", vtb);
        console.log("ccipReadIsm @", ism);
    }
}
