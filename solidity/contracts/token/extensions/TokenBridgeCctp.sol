// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {TypeCasts} from "../../libs/TypeCasts.sol";
import {TokenRouter} from "../libs/TokenRouter.sol";
import {TokenMessage} from "../libs/TokenMessage.sol";
import {HypERC20Collateral} from "../HypERC20Collateral.sol";
import {Quote, ITokenBridge} from "../../interfaces/ITokenBridge.sol";
import {ITokenMessenger} from "../../interfaces/cctp/ITokenMessenger.sol";
import {ITokenMessengerV2} from "../../interfaces/cctp/ITokenMessengerV2.sol";
import {IMessageTransmitter} from "../../interfaces/cctp/IMessageTransmitter.sol";
import {StandardHookMetadata} from "../../hooks/libs/StandardHookMetadata.sol";

contract TokenBridgeCctp is ITokenBridge, HypERC20Collateral {
    using TypeCasts for bytes32;

    uint32 internal constant CCTP_VERSION_1 = 0;
    uint32 internal constant CCTP_VERSION_2 = 1;

    // @dev the minimum to consider it a Standard CCTP transfer (it applies to every network)
    // see https://github.com/circlefin/evm-cctp-contracts/blob/release-2025-03-11T143015/src/v2/MessageTransmitterV2.sol#L224-L244
    // and https://github.com/circlefin/evm-cctp-contracts/blob/release-2025-03-11T143015/src/v2/FinalityThresholds.sol#L21
    uint32 internal constant CCTP_V2_DEFAULT_MIN_FINALITY_THRESHOLD = 2000;

    // @dev required for CCTP v2
    uint256 internal constant CCTP_V2_DEFAULT_MAX_FEE = 0;

    // CCTP token messenger
    // NOTE: be sure to use TokenMessenger (and MessageTransmitter on the ISM)
    // that support the same CCTP version
    ITokenMessenger immutable tokenMessenger;

    /// @notice Hyperlane domain => Circle domain.
    /// ATM, known Circle domains are Ethereum = 0, Avalanche = 1, Optimism = 2, Arbitrum = 3.
    /// Note this could result in ambiguity between the Circle domain being
    /// Ethereum or unknown.
    mapping(uint32 => uint32) public hyperlaneDomainToCircleDomain;

    /**
     * @notice Emitted when the Hyperlane domain to Circle domain mapping is updated.
     * @param hyperlaneDomain The Hyperlane domain.
     * @param circleDomain The Circle domain.
     */
    event DomainAdded(uint32 indexed hyperlaneDomain, uint32 circleDomain);

    /**
     * @notice Raised when the version in use by the TokenMessenger
     * is not recognized
     */
    error UnsupportedCCTPVersion(uint32 wrongVersion);

    constructor(
        address _erc20,
        address _mailbox,
        ITokenMessenger _tokenMessenger
    ) HypERC20Collateral(_erc20, 1, _mailbox) {
        tokenMessenger = _tokenMessenger;
    }

    /**
     * @notice Adds a new mapping between a Hyperlane domain and a Circle domain.
     * @param _hyperlaneDomain The Hyperlane domain.
     * @param _circleDomain The Circle domain.
     */
    function addDomain(
        uint32 _hyperlaneDomain,
        uint32 _circleDomain
    ) external onlyOwner {
        hyperlaneDomainToCircleDomain[_hyperlaneDomain] = _circleDomain;

        emit DomainAdded(_hyperlaneDomain, _circleDomain);
    }

    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    )
        external
        payable
        override(ITokenBridge, TokenRouter)
        returns (bytes32 messageId)
    {
        messageId = TokenRouter._transferRemote(
            _destination,
            _recipient,
            _amount,
            msg.value
        );

        // Has to be called after _transferRemote
        // in order for _transferFromSender to be
        // executed first
        _transferToCctpTokenMessenger(_destination, _amount);
    }

    function quoteTransferRemote(
        uint32 _destination,
        bytes32 /* _recipient */,
        uint256 /* _amount */
    ) external view override returns (Quote[] memory quotes) {
        quotes = new Quote[](1);
        quotes[0] = Quote(address(0), _quoteGasPayment(_destination));
    }

    function _transferToCctpTokenMessenger(
        uint32 _destination,
        uint256 _amount
    ) internal {
        wrappedToken.approve(address(tokenMessenger), _amount);
        uint32 circleDomain = hyperlaneDomainToCircleDomain[_destination];
        uint32 version = tokenMessenger.messageBodyVersion();

        bytes32 router = _mustHaveRemoteRouter(_destination);

        if (version == CCTP_VERSION_1) {
            tokenMessenger.depositForBurn(
                _amount,
                circleDomain,
                router,
                address(wrappedToken)
            );
        } else if (version == CCTP_VERSION_2) {
            ITokenMessengerV2(address(tokenMessenger)).depositForBurn(
                _amount,
                circleDomain,
                router,
                address(wrappedToken),
                bytes32(0),
                CCTP_V2_DEFAULT_MAX_FEE,
                CCTP_V2_DEFAULT_MIN_FINALITY_THRESHOLD
            );
        } else {
            revert UnsupportedCCTPVersion(version);
        }
    }
}
