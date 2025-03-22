// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Script, console} from "forge-std/Script.sol";
import {TypeCasts} from "../contracts/libs/TypeCasts.sol";
import {OPValueTransferBridgeNative} from "../contracts/token/OPValueTransferBridgeNative.sol";
import {OPL2ToL1CcipReadIsm} from "../contracts/isms/hook/OPL2ToL1CcipReadIsm.sol";
import {OPL2ToL1CcipReadHook} from "../contracts/hooks/OPL2ToL1CcipReadHook.sol";

import {IOptimismPortal} from "../contracts/interfaces/optimism/IOptimismPortal.sol";

contract ValueTransferBridgeScript is Script {
    using TypeCasts for address;

    uint32 DOMAIN_OP_SEPOLIA = 11155420;
    uint32 DOMAIN_ETH_SEPOLIA = 11155111;
    // --------------------- Origin ---------------------
    address mailboxOrigin =
        block.chainid == DOMAIN_OP_SEPOLIA
            ? 0x6966b0E55883d49BFB24539356a2f8A673E02039
            : 0xd4C1905BB1D26BC93DAC913e13CaCC278CdCC80D;

    address l2Bridge = 0x4200000000000000000000000000000000000010;

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

    function setL2Bridge(address payable _vtb, address _l2Bridge) public {
        vm.startBroadcast();
        OPValueTransferBridgeNative(_vtb).setL2Bridge(_l2Bridge);
        vm.stopBroadcast();
    }

    function setHook(address payable vtb, address hook) public {
        vm.startBroadcast();
        OPValueTransferBridgeNative(vtb).setHook(hook);
        vm.stopBroadcast();
    }

    function setIsm(address payable vtb, address ism) public {
        vm.startBroadcast();
        OPValueTransferBridgeNative(vtb).setInterchainSecurityModule(ism);
        vm.stopBroadcast();
    }

    function setUrls(address _proveIsm) public {
        vm.startBroadcast();
        OPL2ToL1CcipReadIsm(_proveIsm).setUrls(urls);
        vm.stopBroadcast();
    }

    function deployValueTransferBridge(
        address _l2Bridge,
        address _mailbox
    ) public returns (address) {
        vm.startBroadcast();
        OPValueTransferBridgeNative vtb = new OPValueTransferBridgeNative(
            _l2Bridge,
            _mailbox
        );
        console.log("ValueTransferBridgeNative @", address(vtb));
        vm.stopBroadcast();

        return address(vtb);
    }

    function deployHook(address proveWithdrawalIsm) public returns (address) {
        vm.startBroadcast();
        OPL2ToL1CcipReadHook hook = new OPL2ToL1CcipReadHook(
            mailboxOrigin,
            destination,
            proveWithdrawalIsm.addressToBytes32()
        );
        console.log("proveWithdrawalHook @", address(hook));
        vm.stopBroadcast();

        return address(hook);
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

    function deployIsm() public returns (address) {
        vm.startBroadcast();
        OPL2ToL1CcipReadIsm ism = new OPL2ToL1CcipReadIsm(
            urls,
            opPortal,
            mailboxDestination
        );
        ism.setUrls(urls);
        console.log("OPL2ToL1CcipReadIsm @", address(ism));

        vm.stopBroadcast();
        return address(ism);
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
    ) public returns (bytes32 messageId) {
        vm.startBroadcast();
        OPValueTransferBridgeNative vtb = OPValueTransferBridgeNative(_vtb);
        bytes32 recipient = _recipient.addressToBytes32();
        uint256 fees = vtb.quoteTransferRemote(destination, recipient, amount);

        messageId = vtb.transferRemote{value: fees + amount}(
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
        (address payable vtb, address hook) = deployAllOrigin(
            vm.addr(1),
            vm.addr(2)
        );

        bytes32 messageId = transferRemote(
            payable(vtb),
            destination,
            recipient,
            amount
        );

        console.log("message 2 id");
        console.logBytes32(messageId);
    }

    function deployAllOrigin(
        address remoteRouter,
        address proveWithdrawalIsm
    ) public returns (address payable vtb, address hook) {
        vtb = payable(deployValueTransferBridge(l2Bridge, mailboxOrigin));
        enrollRouter(vtb, destination, remoteRouter);
        hook = deployHook(proveWithdrawalIsm);

        vm.startBroadcast();
        OPValueTransferBridgeNative(vtb).setHook(hook);
        vm.stopBroadcast();

        console.log("vtb @ ", vtb);
        console.log("hook @ ", hook);
    }

    function deployAllDestination() public {
        address payable vtb = payable(
            deployValueTransferBridge(address(0), mailboxDestination)
        );
        address ccipReadIsm = deployIsm();

        vm.startBroadcast();
        OPValueTransferBridgeNative(vtb).setInterchainSecurityModule(
            ccipReadIsm
        );
        vm.stopBroadcast();

        console.log("vtb @", vtb);
        console.log("ccipReadIsm @", ccipReadIsm);
    }

    function process(bytes calldata metadata) public {
        // (
        //     IOptimismPortal.WithdrawalTransaction memory _tx,
        //     uint256 _disputeGameIndex,
        //     IOptimismPortal.OutputRootProof memory _outputRootProof,
        //     bytes[] memory _withdrawalProof
        // ) = abi.decode(
        //         metadata,
        //         (
        //             IOptimismPortal.WithdrawalTransaction,
        //             uint256,
        //             IOptimismPortal.OutputRootProof,
        //             bytes[]
        //         )
        //     );

        // bytes memory messageId = _getL2Message(_tx.data);

        // console.log("messageId");
        // console.logBytes32(abi.decode(messageId, (bytes32)));

        // console.log("withdrawal tx encoded");
        // console.logBytes(abi.encode(_tx));

        console.log("x:");
        console.logBytes(abi.decode(metadata, (bytes)));
    }

    function _getL2Message(
        bytes memory txData
    ) internal returns (bytes memory) {
        (
            uint256 _destination,
            address _source,
            address _nonce,
            uint256 _sender,
            uint256 _target,
            bytes memory _message
        ) = abi.decode(
                _removeFirst4Bytes(txData),
                (uint256, address, address, uint256, uint256, bytes)
            );

        (address from, address to, uint256 amount, bytes memory extraData) = abi
            .decode(
                _removeFirst4Bytes(_message),
                (address, address, uint256, bytes)
            );

        return extraData;
    }

    function _removeFirst4Bytes(
        bytes memory data
    ) internal pure returns (bytes memory) {
        require(data.length >= 4, "Data must be at least 4 bytes long");

        bytes memory result = new bytes(data.length - 4);

        assembly {
            let src := add(data, 0x24) // Skip the length (0x20) and first 4 bytes (0x04)
            let dest := add(result, 0x20) // Destination starts at 0x20 (after length prefix)
            let len := sub(mload(data), 4) // Adjust length

            mstore(result, len) // Store new length
            for {
                let i := 0
            } lt(i, len) {
                i := add(i, 32)
            } {
                mstore(add(dest, i), mload(add(src, i)))
            }
        }

        return result;
    }
}
