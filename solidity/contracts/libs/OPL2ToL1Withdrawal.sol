// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IOptimismPortal} from "../interfaces/optimism/IOptimismPortal.sol";
import {IStandardBridge} from "../interfaces/optimism/IStandardBridge.sol";
import {ICrossDomainMessenger, IL2ToL1MessagePasser} from "../interfaces/optimism/ICrossDomainMessenger.sol";

/**
 * @title Hyperlane OPL2ToL1Withdrawal Library
 * @notice Library to calculate the withdrawal hash for OPL2ToL1CcipReadIsm
 * validation
 */
library OPL2ToL1Withdrawal {
    /// @dev Copied from Hashing.sol of Optimism
    function hashWithdrawal(
        IOptimismPortal.WithdrawalTransaction memory _tx
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    _tx.nonce,
                    _tx.sender,
                    _tx.target,
                    _tx.value,
                    _tx.gasLimit,
                    _tx.data
                )
            );
    }

    /**
     * @dev Abi encodes the withdrawal hash in order to be included into
     * the TokenMessage metadata. This will be used for further verification
     * on the CCIP-read contract on L1
     */
    function getWithdrawalMetadata(
        address payable _l2Bridge,
        address _l2MessagePasser,
        uint32 _l1MinGasLimit,
        address _remoteRouter,
        uint256 _amountOrId,
        bytes memory _extraData
    ) internal view returns (bytes memory metadata) {
        IStandardBridge l2Bridge = IStandardBridge(_l2Bridge);
        ICrossDomainMessenger messenger = l2Bridge.MESSENGER();

        bytes memory message = abi.encodeWithSelector(
            IStandardBridge.finalizeBridgeETH.selector,
            address(this),
            _remoteRouter,
            _amountOrId,
            _extraData
        );

        bytes memory data = abi.encodeWithSelector(
            ICrossDomainMessenger.relayMessage.selector,
            messenger.messageNonce(),
            address(_l2Bridge), // sender
            address(l2Bridge.OTHER_BRIDGE()), // target
            _amountOrId, // value
            _l1MinGasLimit,
            message
        );

        uint256 messagePasserNonce = IL2ToL1MessagePasser(_l2MessagePasser)
            .messageNonce();

        metadata = abi.encode(
            hashWithdrawal(
                IOptimismPortal.WithdrawalTransaction({
                    nonce: messagePasserNonce,
                    sender: address(messenger),
                    target: messenger.OTHER_MESSENGER(),
                    value: _amountOrId,
                    gasLimit: messenger.baseGas(message, _l1MinGasLimit),
                    data: data
                })
            )
        );
    }
}
