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
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {Message} from "../../libs/Message.sol";
import {AbstractMessageIdAuthorizedIsm} from "./AbstractMessageIdAuthorizedIsm.sol";

// ============ External Imports ============

import {IOutbox} from "@arbitrum/nitro-contracts/src/bridge/IOutbox.sol";
import {CrossChainEnabledArbitrumL1} from "@openzeppelin/contracts/crosschain/arbitrum/CrossChainEnabledArbitrumL1.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/**
 * @title ArbL2ToL1Ism
 * @notice Uses the native Arbitrum bridge to verify interchain messages from L2 to L1.
 */
contract ArbL2ToL1Ism is
    CrossChainEnabledArbitrumL1,
    IInterchainSecurityModule,
    Initializable
{
    // ============ Constants ============

    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.ARB_L2_TO_L1);

    uint256 private constant _LOCKED = 1;
    uint256 private constant _UNLOCKED = 2;
    uint256 private _lock = _LOCKED;

    // ============ Public Storage ============

    /// @notice address for the authorized hook
    bytes32 public authorizedHook;

    IOutbox public arbOutbox;

    modifier unlocked() {
        require(_lock == _UNLOCKED, "ArbL2ToL1Ism: locked");
        _;
        _lock = _LOCKED;
    }

    // ============ Constructor ============

    constructor(
        address _bridge,
        address _outbox
    ) CrossChainEnabledArbitrumL1(_bridge) {
        require(
            Address.isContract(_bridge),
            "ArbL2ToL1Ism: invalid Arbitrum Bridge"
        );
        arbOutbox = IOutbox(_outbox);
    }

    // ============ Initializer ============

    function setAuthorizedHook(bytes32 _hook) external initializer {
        require(_hook != bytes32(0), "ArbL2ToL1Ism: invalid authorized hook");
        authorizedHook = _hook;
    }

    // ============ External Functions ============

    function verifyMessageId(bytes32 messageId) external unlocked {
        require(_isAuthorized(), "ArbL2ToL1Ism: unauthorized hook");
    }

    function verify(
        bytes calldata _metadata,
        bytes calldata message
    ) external returns (bool) {
        _unlock();

        (
            bytes32[] memory proof,
            uint256 index,
            address l2Sender,
            address to,
            uint256 l2Block,
            uint256 l1Block,
            uint256 l2Timestamp,
            uint256 value,
            bytes memory data
        ) = abi.decode(
                _metadata,
                (
                    bytes32[],
                    uint256,
                    address,
                    address,
                    uint256,
                    uint256,
                    uint256,
                    uint256,
                    bytes
                )
            );

        require(
            l2Sender == TypeCasts.bytes32ToAddress(authorizedHook),
            "ArbL2ToL1Ism: l2Sender != authorizedHook"
        );

        bytes32 messageId = Message.id(message);

        bytes32 convertedBytes;
        assembly {
            convertedBytes := mload(add(data, 36))
        }
        require(
            convertedBytes == messageId,
            "ArbL2ToL1Ism: invalid message id"
        );

        arbOutbox.executeTransaction(
            proof,
            index,
            l2Sender,
            to,
            l2Block,
            l1Block,
            l2Timestamp,
            value,
            data
        );
    }

    // ============ Internal function ============

    /**
     * @notice Check if sender is authorized to message `verifyMessageId`.
     */
    function _isAuthorized() internal view returns (bool) {
        return
            _crossChainSender() == TypeCasts.bytes32ToAddress(authorizedHook);
    }

    function _unlock() internal {
        _lock = _UNLOCKED;
    }
}
