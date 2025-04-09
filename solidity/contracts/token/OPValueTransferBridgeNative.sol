// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {TypeCasts} from "../libs/TypeCasts.sol";
import {HypNative} from "../token/HypNative.sol";
import {StandardHookMetadata} from "../hooks/libs/StandardHookMetadata.sol";
import {TokenMessage} from "../token/libs/TokenMessage.sol";
import {IStandardBridge} from "../interfaces/optimism/IStandardBridge.sol";
import {IOptimismPortal} from "../interfaces/optimism/IOptimismPortal.sol";
import {Quotes, IValueTransferBridge} from "../interfaces/IValueTransferBridge.sol";
import {IL2CrossDomainMessenger, ICrossDomainMessenger, IL2ToL1MessagePasser} from "../interfaces/optimism/ICrossDomainMessenger.sol";

import {console} from "forge-std/console.sol";

contract OPValueTransferBridgeNative is IValueTransferBridge, HypNative {
    using TypeCasts for bytes32;

    IL2ToL1MessagePasser public constant L2_TO_L1_MESSAGE_PASSER =
        IL2ToL1MessagePasser(
            payable(0x4200000000000000000000000000000000000016)
        );
    uint32 public constant L1_MIN_GAS_LIMIT = 50_000; // FIXME
    uint32 constant HOOK_METADATA_GAS_LIMIT = 450_000;

    // L2 bridge used to initiate the withdrawal
    IStandardBridge public immutable l2Bridge;
    // L1 domain where the withdrawal will be finalized
    uint32 public immutable l1Domain;

    constructor(
        uint32 _l1Domain,
        address _l2Bridge,
        address _mailbox
    ) HypNative(_mailbox) {
        l1Domain = _l1Domain;
        l2Bridge = IStandardBridge(payable(_l2Bridge));
    }

    function quoteTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external view override returns (Quotes[] memory quotes) {
        quotes = new Quotes[](1);
        bytes memory hookMetadata = StandardHookMetadata.overrideGasLimit(
            HOOK_METADATA_GAS_LIMIT
        );

        bytes memory tokenMessage = TokenMessage.format(
            _recipient,
            _amount,
            bytes("") // metadata
        );

        quotes[0] = Quotes(
            address(0),
            _Router_quoteDispatch(
                l1Domain,
                tokenMessage,
                hookMetadata,
                address(hook)
            )
        );
    }

    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    )
        public
        payable
        override(HypNative, IValueTransferBridge)
        returns (bytes32)
    {
        return super.transferRemote(_destination, _recipient, _amount);
    }

    function _transferFromSender(
        uint256 _amountOrId
    ) internal override returns (bytes memory metadata) {
        address remoteRouter = _mustHaveRemoteRouter(l1Domain)
            .bytes32ToAddress();
        bytes memory extraData = bytes("");

        // IMPORTANT: this must be placed before the l2Bridge.bridgeETHto()
        // call in order to work (nonce will change during the withdrawal)
        metadata = _getWithdrawalMetadata(remoteRouter, _amountOrId, extraData);

        l2Bridge.bridgeETHTo{value: _amountOrId}(
            remoteRouter,
            L1_MIN_GAS_LIMIT,
            extraData
        );
    }

    /**
     * @dev Abi encodes the withdrawal hash in order to be included into
     * the TokenMessage metadata. This will be used for further verification
     * on the CCIP-read contract on L1
     */
    function _getWithdrawalMetadata(
        address _remoteRouter,
        uint256 _amountOrId,
        bytes memory _extraData
    ) internal view returns (bytes memory metadata) {
        IL2CrossDomainMessenger messenger = IL2CrossDomainMessenger(
            address(l2Bridge.MESSENGER())
        );

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
            address(l2Bridge), // sender
            address(l2Bridge.OTHER_BRIDGE()), // target
            _amountOrId, // value
            L1_MIN_GAS_LIMIT,
            message
        );

        uint256 messagePasserNonce = IL2ToL1MessagePasser(
            L2_TO_L1_MESSAGE_PASSER
        ).messageNonce();

        metadata = abi.encode(
            _hashWithdrawal(
                IOptimismPortal.WithdrawalTransaction({
                    nonce: messagePasserNonce,
                    sender: address(messenger),
                    target: messenger.OTHER_MESSENGER(),
                    value: _amountOrId,
                    gasLimit: messenger.baseGas(message, L1_MIN_GAS_LIMIT),
                    data: data
                })
            )
        );
    }

    /// @dev Copied from Hashing.sol of Optimism
    function _hashWithdrawal(
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
}
