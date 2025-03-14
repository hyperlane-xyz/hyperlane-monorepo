// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Script, console} from "forge-std/Script.sol";
import {TypeCasts} from "../contracts/libs/TypeCasts.sol";
import {Message} from "../contracts/libs/Message.sol";
import {OPValueTransferBridgeNative} from "../contracts/token/OPValueTransferBridgeNative.sol";
import {OPL2ToL1CcipReadIsm} from "../contracts/isms/hook/OPL2ToL1CcipReadIsm.sol";
import {OPL2ToL1CcipReadHook} from "../contracts/hooks/OPL2ToL1CcipReadHook.sol";
import {IOptimismPortal} from "../contracts/interfaces/optimism/IOptimismPortal.sol";

import {IOptimismPortal} from "../contracts/interfaces/optimism/IOptimismPortal.sol";

contract ValueTransferBridgeScript is Script {
    using TypeCasts for address;
    using Message for bytes;

    uint256 L2_DOMAIN = vm.envUint("L2_DOMAIN");
    uint256 L1_DOMAIN = vm.envUint("L1_DOMAIN");
    // --------------------- Origin ---------------------
    address mailboxOrigin = vm.envAddress("L2_MAILBOX");
    address l2Bridge = vm.envAddress("L2_BRIDGE");

    uint32 destination = uint32(L1_DOMAIN);

    // ------------------- Destination -------------------
    address mailboxDestination = vm.envAddress("L1_MAILBOX");
    address opPortal = vm.envAddress("L1_PORTAL");

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
            destination,
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
            proveWithdrawalIsm,
            address(0)
        );
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
        vtb = new OPValueTransferBridgeNative(
            destination,
            address(0),
            mailboxDestination
        );
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

        messageId = vtb.transferRemote{value: amount + fees}(
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

        vm.createSelectFork("l1");
        (address remoteVtb, address ism) = deployAllDestination();

        vm.createSelectFork("l2");
        (address payable vtb, address hook) = deployAllOrigin(remoteVtb, ism);

        vm.createSelectFork("l1");
        enrollRouter(vtb, uint32(L2_DOMAIN), remoteVtb);

        console.log("# ============ L2 ============");
        console.log("# vtb  @ ", vtb);
        console.log("# hook @", hook);
        console.log("# ============ L1 ============");
        console.log("# vtb  @", remoteVtb);
        console.log("# ism  @", ism);
        // bytes32 messageId = transferRemote(
        //     payable(vtb),
        //     destination,
        //     recipient,
        //     amount
        // );
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

    function deployAllDestination()
        public
        returns (address payable vtb, address ism)
    {
        vtb = payable(
            deployValueTransferBridge(address(0), mailboxDestination)
        );
        ism = deployIsm();

        vm.startBroadcast();
        OPValueTransferBridgeNative(vtb).setInterchainSecurityModule(ism);
        vm.stopBroadcast();

        console.log("vtb @", vtb);
        console.log("ccipReadIsm @", ism);
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

    function getRecipient(bytes calldata message) public {
        console.log("Recipient");
        console.log(message.recipient() == address(this).addressToBytes32());
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

    function abiDecode(bytes calldata _metadata) public {
        (
            IOptimismPortal.WithdrawalTransaction memory _tx,
            uint256 _disputeGameIndex,
            IOptimismPortal.OutputRootProof memory _outputRootProof,
            bytes[] memory _withdrawalProof
        ) = abi.decode(
                _metadata,
                (
                    IOptimismPortal.WithdrawalTransaction,
                    uint256,
                    IOptimismPortal.OutputRootProof,
                    bytes[]
                )
            );
        console.log("bytes");
        console.log(_tx.value);
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
