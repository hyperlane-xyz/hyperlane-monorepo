// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Script, console} from "forge-std/Script.sol";
import {TypeCasts} from "../contracts/libs/TypeCasts.sol";
import {OPValueTransferBridgeNative} from "../contracts/token/OPValueTransferBridgeNative.sol";
import {OPL2ToL1ProveWithdrawalIsm} from "../contracts/isms/hook/OPL2ToL1ProveWithdrawalIsm.sol";
import {OPL2ToL1FinalizeWithdrawalIsm} from "../contracts/isms/hook/OPL2ToL1FinalizeWithdrawalIsm.sol";
import {OPL2ToL1ProveWithdrawalHook} from "../contracts/hooks/OPL2ToL1ProveWithdrawalHook.sol";

contract ValueTransferBridgeScript is Script {
    using TypeCasts for address;

    uint32 DOMAIN_OP_SEPOLIA = 11155420;
    uint32 DOMAIN_ETH_SEPOLIA = 11155111;
    // --------------------- Origin ---------------------
    address mailboxOrigin =
        block.chainid == DOMAIN_OP_SEPOLIA
            ? 0x6966b0E55883d49BFB24539356a2f8A673E02039
            : 0xd4C1905BB1D26BC93DAC913e13CaCC278CdCC80D;

    address l2Bridge =
        block.chainid == DOMAIN_OP_SEPOLIA
            ? 0x6966b0E55883d49BFB24539356a2f8A673E02039
            : 0xd4C1905BB1D26BC93DAC913e13CaCC278CdCC80D;

    uint32 destination = block.chainid == DOMAIN_OP_SEPOLIA ? 11155111 : 1;

    // ------------------- Destination -------------------
    address mailboxDestination =
        block.chainid == DOMAIN_ETH_SEPOLIA
            ? 0xfFAEF09B3cd11D9b20d1a19bECca54EEC2884766
            : 0xc005dc82818d67AF737725bD4bf75435d065D239;

    address opPortal =
        block.chainid == DOMAIN_ETH_SEPOLIA
            ? 0x16Fc5058F25648194471939df75CF27A2fdC48BC
            : 0xbEb5Fc579115071764c7423A4f12eDde41f106Ed;

    string[] urls = vm.envString("CCIP_READ_URLS", ",");

    function deployOrigin() public returns (OPValueTransferBridgeNative vtb) {
        vm.startBroadcast();
        vtb = new OPValueTransferBridgeNative(l2Bridge, mailboxOrigin);
        console.log("ValueTransferBridgeNative @", address(vtb));
        vm.stopBroadcast();
    }

    function deployHook(
        address proveWithdrawalIsm
    ) public returns (OPL2ToL1ProveWithdrawalHook hook) {
        vm.startBroadcast();
        hook = new OPL2ToL1ProveWithdrawalHook(
            mailboxOrigin,
            destination,
            proveWithdrawalIsm.addressToBytes32()
        );
        console.log("proveWithdrawalHook @", address(hook));
        vm.stopBroadcast();
    }

    function deployProveIsm() public returns (OPL2ToL1ProveWithdrawalIsm ism) {
        vm.startBroadcast();
        ism = new OPL2ToL1ProveWithdrawalIsm(urls, opPortal);
        ism.setUrls(urls);
        console.log("ProveWithdrawalIsm @", address(ism));
        vm.stopBroadcast();
    }

    function setupValueTransferBridge(
        OPValueTransferBridgeNative vtb,
        address hook,
        address ism
    ) public {
        vm.startBroadcast();
        vtb.setHook(hook);
        vtb.setInterchainSecurityModule(ism);
        vm.stopBroadcast();
    }

    function enrollRouter(
        address payable vtb,
        uint32 domain,
        address router
    ) public {
        vm.startBroadcast();
        OPValueTransferBridgeNative(vtb).enrollRemoteRouter(
            domain,
            router.addressToBytes32()
        );
        vm.stopBroadcast();
    }

    function deployFinalizeIsm()
        public
        returns (OPL2ToL1FinalizeWithdrawalIsm ism)
    {
        vm.startBroadcast();
        ism = new OPL2ToL1FinalizeWithdrawalIsm(urls, opPortal);
        ism.setUrls(urls);
        console.log("FinalizeWithdrawalIsm @", address(ism));
        vm.stopBroadcast();
    }

    function deployDestination()
        public
        returns (OPValueTransferBridgeNative vtb)
    {
        vm.startBroadcast();
        vtb = new OPValueTransferBridgeNative(address(0), mailboxDestination);
        console.log("ValueTransferBridgeNative @", address(vtb));
        vm.stopBroadcast();
    }

    function transferRemote(
        address payable _vtb,
        uint32 _destination,
        address _recipient,
        uint256 amount
    ) public {
        vm.startBroadcast();
        OPValueTransferBridgeNative vtb = OPValueTransferBridgeNative(_vtb);
        bytes32 recipient = _recipient.addressToBytes32();
        uint256 fees = vtb.quoteTransferRemote(destination, recipient, amount);

        bytes32 messageId = vtb.transferRemote{value: fees + amount}(
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
        uint256 amount = 0.0001 ether;
        OPValueTransferBridgeNative vtb = deployOrigin();

        transferRemote(payable(vtb), destination, recipient, amount);
    }
}
