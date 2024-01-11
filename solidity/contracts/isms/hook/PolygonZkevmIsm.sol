// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/*@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
     @@@@@  HYPERLANE  @@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
@@@@@@@@@       @@@@@@@@*/

// ============ Internal Imports ============

import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {Message} from "../../libs/Message.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {AbstractCcipReadIsm} from "../ccip-read/AbstractCcipReadIsm.sol";
import {IMailbox} from "../../interfaces/IMailbox.sol";
import {IPolygonZkEVMBridge} from "../../interfaces/polygonzkevm/IPolygonZkEVMBridge.sol";
import {AbstractMessageIdAuthorizedIsm} from "../hook/AbstractMessageIdAuthorizedIsm.sol";

// ============ External Imports ============
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

contract PolygonZkevmIsm is AbstractCcipReadIsm {
    using Message for bytes;
    IMailbox public mailbox;
    string[] public offchainUrls;
    uint256 public constant _DEPOSIT_CONTRACT_TREE_DEPTH = 32;
    // ============ Constants ============

    IPolygonZkEVMBridge public immutable zkEvmBridge;

    // ============ Constructor ============

    constructor(
        address _zkEvmBridge,
        IMailbox _mailbox,
        string[] memory _offchainUrls
    ) {
        require(
            Address.isContract(_zkEvmBridge),
            "PolygonZkevmIsm: invalid L2Messenger"
        );
        zkEvmBridge = IPolygonZkEVMBridge(_zkEvmBridge);
        mailbox = _mailbox;
        offchainUrls = _offchainUrls;
    }

    function getOffchainVerifyInfo(
        bytes calldata _message
    ) external view override {
        revert OffchainLookup(
            address(this),
            offchainUrls,
            _message,
            PolygonZkevmIsm.process.selector,
            _message
        );
    }

    function verify(
        bytes calldata _metadata,
        bytes calldata
    ) external returns (bool) {
        (
            bytes32[_DEPOSIT_CONTRACT_TREE_DEPTH] memory smtProof,
            uint32 index,
            bytes32 mainnetExitRoot,
            bytes32 rollupExitRoot,
            uint32 originNetwork,
            address originAddress,
            uint32 destinationNetwork,
            address destinationAddress,
            uint256 amount,
            bytes memory payload
        ) = abi.decode(
                _metadata,
                (
                    bytes32[32],
                    uint32,
                    bytes32,
                    bytes32,
                    uint32,
                    address,
                    uint32,
                    address,
                    uint256,
                    bytes
                )
            );
        zkEvmBridge.claimMessage(
            smtProof,
            index,
            mainnetExitRoot,
            rollupExitRoot,
            originNetwork,
            originAddress,
            destinationNetwork,
            destinationAddress,
            amount,
            payload
        );
        return true;
    }

    function process(
        bytes calldata _metadata,
        bytes calldata _message
    ) external {
        mailbox.process(_metadata, _message);
    }
}
