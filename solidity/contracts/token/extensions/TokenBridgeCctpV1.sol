// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {TypeCasts} from "../../libs/TypeCasts.sol";
import {TokenRouter} from "../libs/TokenRouter.sol";
import {TokenBridgeCctp} from "../TokenBridgeCctp.sol";
import {CctpMessage} from "../../libs/CctpMessage.sol";
import {HypERC20Collateral} from "../HypERC20Collateral.sol";
import {Quote, ITokenBridge} from "../../interfaces/ITokenBridge.sol";
import {ITokenMessenger} from "../../interfaces/cctp/ITokenMessenger.sol";
import {IMessageTransmitter} from "../../interfaces/cctp/IMessageTransmitter.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {AbstractCcipReadIsm} from "../../isms/ccip-read/AbstractCcipReadIsm.sol";

import {TypedMemView} from "@memview-sol/contracts/TypedMemView.sol";

contract TokenBridgeCctpV1 is TokenBridgeCctp {
    using CctpMessage for bytes29;

    // @notice CCTP token messenger contract
    ITokenMessenger public immutable tokenMessenger;

    constructor(
        address _erc20,
        uint256 _scale,
        address _mailbox,
        IMessageTransmitter _messageTransmitter,
        ITokenMessenger _tokenMessenger
    ) TokenBridgeCctp(_erc20, _scale, _mailbox, _messageTransmitter) {
        uint32 version = _tokenMessenger.messageBodyVersion();
        require(
            version == CCTP_VERSION_1,
            "Invalid TokenMessenger CCTP version"
        );

        version = _messageTransmitter.version();
        require(
            version == CCTP_VERSION_1,
            "Invalid messageTransmitter CCTP version"
        );

        tokenMessenger = _tokenMessenger;
    }

    function _isMessageReceived(
        bytes memory cctpMessage
    ) internal view override returns (bool) {
        bytes29 originalMsg = TypedMemView.ref(cctpMessage, 0);
        uint64 nonceUint64 = originalMsg._nonce();
        uint32 sourceDomain = originalMsg._sourceDomain();

        bytes32 nonce = keccak256(abi.encodePacked(sourceDomain, nonceUint64));

        return messageTransmitter.usedNonces(nonce) != 0;
    }

    function _cctpDepositForBurn(
        uint32 _destination,
        uint256 _amount
    ) internal override {
        wrappedToken.approve(address(tokenMessenger), _amount);
        uint32 circleDomain = hyperlaneDomainToCircleDomain[_destination];

        bytes32 router = _mustHaveRemoteRouter(_destination);

        tokenMessenger.depositForBurn(
            _amount,
            circleDomain,
            router,
            address(wrappedToken)
        );
    }
}
