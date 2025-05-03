// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Message} from "../libs/Message.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {TokenMessage} from "../token/libs/TokenMessage.sol";
import {ITokenMessenger} from "../interfaces/cctp/ITokenMessenger.sol";
import {ITokenMessengerV2} from "../interfaces/cctp/ITokenMessengerV2.sol";
import {IMessageTransmitter} from "../interfaces/cctp/IMessageTransmitter.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";
import {AbstractPostDispatchHook} from "./libs/AbstractPostDispatchHook.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract CctpHook is AbstractPostDispatchHook, Ownable {
    using Message for bytes;

    uint256 internal constant CCTP_V2_DEFAULT_MAX_FEE = 0;
    // @dev the minimum to consider it a Standard CCTP transfer (it applies to every network)
    // see https://github.com/circlefin/evm-cctp-contracts/blob/release-2025-03-11T143015/src/v2/MessageTransmitterV2.sol#L224-L244
    // and https://github.com/circlefin/evm-cctp-contracts/blob/release-2025-03-11T143015/src/v2/FinalityThresholds.sol#L21
    uint32 internal constant CCTP_V2_DEFAULT_MIN_FINALITY_THRESHOLD = 2000;

    // we keep the token messenger here in order to
    // provide the right quote
    ITokenMessenger immutable tokenMessenger;
    IPostDispatchHook public immutable childHook;

    // we specify the IGP here in order to make
    // the transfer `user => TokenBridge => CctpHook`
    // easier. A StaticAggregationHook has been considered
    // but there is no consistent way to retrieve the
    // correct hook when performing the approval on the
    // token bridge
    IPostDispatchHook igp;

    // ============ Constructor ============
    constructor(
        ITokenMessenger _tokenMessenger,
        IPostDispatchHook _igp,
        IPostDispatchHook _childHook
    ) {
        igp = _igp;
        tokenMessenger = _tokenMessenger;
        childHook = _childHook;
    }

    /**
     * @notice Emitted when the Hyperlane domain to Circle domain mapping is updated.
     * @param hyperlaneDomain The Hyperlane domain.
     * @param circleDomain The Circle domain.
     */
    event DomainAdded(uint32 indexed hyperlaneDomain, uint32 circleDomain);

    /// @notice Hyperlane domain => Circle domain.
    /// ATM, known Circle domains are Ethereum = 0, Avalanche = 1, Optimism = 2, Arbitrum = 3.
    /// Note this could result in ambiguity between the Circle domain being
    /// Ethereum or unknown.
    mapping(uint32 => uint32) public hyperlaneDomainToCircleDomain;

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

    function hookType() external pure override returns (uint8) {
        return uint8(IPostDispatchHook.Types.CCTP);
    }

    /// @inheritdoc AbstractPostDispatchHook
    function _quoteDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) internal view override returns (uint256 fee) {
        return igp.quoteDispatch(metadata, message);
    }

    /// @inheritdoc AbstractPostDispatchHook
    function _postDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) internal override {
        // Wrapped token is encoded into the metadata, see TokenBridgeCctp
        address token = address(
            bytes20(TokenMessage.metadata(message.body())[0:20])
        );
        uint256 amount = TokenMessage.amount(message.body());

        IERC20(token).approve(address(tokenMessenger), amount);

        uint32 circleDomain = hyperlaneDomainToCircleDomain[
            message.destination()
        ];

        bytes32 recipient = message.recipient();

        if (tokenMessenger.messageBodyVersion() == 0) {
            // CCTP v1
            tokenMessenger.depositForBurn(
                amount,
                circleDomain,
                recipient,
                token
            );
        } else if (tokenMessenger.messageBodyVersion() == 1) {
            // CCTP v2
            ITokenMessengerV2(address(tokenMessenger)).depositForBurn(
                amount,
                circleDomain,
                recipient,
                token,
                bytes32(0),
                CCTP_V2_DEFAULT_MAX_FEE,
                CCTP_V2_DEFAULT_MIN_FINALITY_THRESHOLD
            );
        }

        uint256 fees = igp.quoteDispatch(metadata, message);
        igp.postDispatch{value: fees}(metadata, message);
    }
}
