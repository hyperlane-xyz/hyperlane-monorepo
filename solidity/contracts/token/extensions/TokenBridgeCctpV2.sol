// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {TokenBridgeCctp} from "../TokenBridgeCctp.sol";
import {CctpMessageV2} from "../../libs/CctpMessageV2.sol";
import {ITokenMessengerV2} from "../../interfaces/cctp/ITokenMessengerV2.sol";
import {IMessageTransmitter} from "../../interfaces/cctp/IMessageTransmitter.sol";
import {TypedMemView} from "../../libs/TypedMemView.sol";

contract TokenBridgeCctpV2 is TokenBridgeCctp {
    using CctpMessageV2 for bytes29;

    // @dev the minimum to consider it a Standard CCTP transfer (it applies to every network)
    // see https://github.com/circlefin/evm-cctp-contracts/blob/release-2025-03-11T143015/src/v2/MessageTransmitterV2.sol#L224-L244
    // and https://github.com/circlefin/evm-cctp-contracts/blob/release-2025-03-11T143015/src/v2/FinalityThresholds.sol#L21
    uint32 internal constant CCTP_V2_DEFAULT_MIN_FINALITY_THRESHOLD = 2000;

    // @dev required for CCTP v2
    uint256 internal constant CCTP_V2_DEFAULT_MAX_FEE = 0;

    ITokenMessengerV2 public immutable tokenMessenger;

    constructor(
        address _erc20,
        uint256 _scale,
        address _mailbox,
        IMessageTransmitter _messageTransmitter,
        ITokenMessengerV2 _tokenMessenger,
        string[] memory __urls
    ) TokenBridgeCctp(_erc20, _scale, _mailbox, _messageTransmitter, __urls) {
        uint32 version = _tokenMessenger.messageBodyVersion();
        require(
            version == CCTP_VERSION_2,
            "Invalid TokenMessenger CCTP version"
        );

        version = _messageTransmitter.version();
        require(
            version == CCTP_VERSION_2,
            "Invalid messageTransmitter CCTP version"
        );

        tokenMessenger = _tokenMessenger;
        wrappedToken.approve(address(tokenMessenger), type(uint256).max);
    }

    function _cctpDepositForBurn(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) internal override {
        tokenMessenger.depositForBurn(
            _amount,
            _destination,
            _recipient,
            address(wrappedToken),
            bytes32(0),
            CCTP_V2_DEFAULT_MAX_FEE,
            CCTP_V2_DEFAULT_MIN_FINALITY_THRESHOLD
        );
    }

    function _isMessageReceived(
        bytes memory cctpMessage
    ) internal view override returns (bool) {
        bytes29 originalMsg = TypedMemView.ref(cctpMessage, 0);
        bytes32 nonce = originalMsg._getNonce();

        return messageTransmitter.usedNonces(nonce) != 0;
    }
}
