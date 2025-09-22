// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {TokenRouter} from "./libs/TokenRouter.sol";
import {HypERC20Collateral} from "./HypERC20Collateral.sol";
import {IMessageTransmitter} from "./../interfaces/cctp/IMessageTransmitter.sol";
import {IInterchainSecurityModule} from "./../interfaces/IInterchainSecurityModule.sol";
import {AbstractCcipReadIsm} from "./../isms/ccip-read/AbstractCcipReadIsm.sol";
import {TypedMemView} from "./../libs/TypedMemView.sol";
import {ITokenMessenger} from "./../interfaces/cctp/ITokenMessenger.sol";
import {Message} from "./../libs/Message.sol";
import {TokenMessage} from "./libs/TokenMessage.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";
import {StandardHookMetadata} from "../hooks/libs/StandardHookMetadata.sol";
import {IMessageHandler} from "../interfaces/cctp/IMessageHandler.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {MovableCollateralRouter} from "./libs/MovableCollateralRouter.sol";
import {TokenRouter} from "./libs/TokenRouter.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface CctpService {
    function getCCTPAttestation(
        bytes calldata _message
    )
        external
        view
        returns (bytes memory cctpMessage, bytes memory attestation);
}

abstract contract TokenBridgeCctpBase is
    TokenRouter,
    AbstractCcipReadIsm,
    IPostDispatchHook
{
    using Message for bytes;
    using TypeCasts for bytes32;
    using SafeERC20 for IERC20;

    uint256 private constant _SCALE = 1;

    IERC20 public immutable wrappedToken;

    // @notice CCTP message transmitter contract
    IMessageTransmitter public immutable messageTransmitter;

    // @notice CCTP token messenger contract
    ITokenMessenger public immutable tokenMessenger;

    struct Domain {
        uint32 hyperlane;
        uint32 circle;
    }

    /// @notice Hyperlane domain => Circle domain.
    /// We use a struct to avoid ambiguity with domain 0 being unknown.
    mapping(uint32 hypDomain => Domain circleDomain) internal _domainMap;

    /**
     * @notice Emitted when the Hyperlane domain to Circle domain mapping is updated.
     * @param hyperlaneDomain The Hyperlane domain.
     * @param circleDomain The Circle domain.
     */
    event DomainAdded(uint32 indexed hyperlaneDomain, uint32 circleDomain);

    constructor(
        address _erc20,
        address _mailbox,
        IMessageTransmitter _messageTransmitter,
        ITokenMessenger _tokenMessenger
    ) TokenRouter(_SCALE, _mailbox) {
        require(
            _messageTransmitter.version() == _getCCTPVersion(),
            "Invalid messageTransmitter CCTP version"
        );
        messageTransmitter = _messageTransmitter;

        require(
            _tokenMessenger.messageBodyVersion() == _getCCTPVersion(),
            "Invalid TokenMessenger CCTP version"
        );
        tokenMessenger = _tokenMessenger;

        wrappedToken = IERC20(_erc20);

        _disableInitializers();
    }

    function initialize(
        address _hook,
        address _owner,
        string[] memory __urls
    ) external virtual initializer {
        // ISM should not be set
        _MailboxClient_initialize(_hook, address(0), _owner);

        // Setup urls for offchain lookup and do token approval
        setUrls(__urls);
        wrappedToken.approve(address(tokenMessenger), type(uint256).max);
    }

    // ============ TokenRouter overrides ============

    /**
     * @inheritdoc TokenRouter
     * @dev Overrides to return the wrapped token address (instead of implementing HypERC20Collateral).
     */
    function token() public view virtual override returns (address) {
        return address(wrappedToken);
    }

    /**
     * @inheritdoc TokenRouter
     * @dev Overrides to bridge the tokens via Circle.
     */
    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) public payable virtual override returns (bytes32 messageId) {
        // 1. Calculate the fee amounts, charge the sender and distribute to feeRecipient if necessary
        (
            uint256 externalFee,
            uint256 remainingNativeValue
        ) = _calculateFeesAndCharge(
                _destination,
                _recipient,
                _amount,
                msg.value
            );

        // 2. Prepare the token message with the recipient, amount, and any additional metadata in overrides
        uint32 circleDomain = hyperlaneDomainToCircleDomain(_destination);
        bytes memory _message = _bridgeViaCircle(
            circleDomain,
            _recipient,
            _amount + externalFee
        );

        // 3. Emit the SentTransferRemote event and 4. dispatch the message
        return
            _emitAndDispatch(
                _destination,
                _recipient,
                _amount,
                remainingNativeValue,
                _message
            );
    }

    /**
     * @inheritdoc TokenRouter
     * @dev Overrides to transfer the tokens from the sender to this contract (like HypERC20Collateral).
     */
    function _transferFromSender(uint256 _amount) internal virtual override {
        wrappedToken.safeTransferFrom(msg.sender, address(this), _amount);
    }

    /**
     * @inheritdoc TokenRouter
     * @dev Overrides to not transfer the tokens to the recipient, as the CCTP transfer will do it.
     */
    function _transferTo(
        address _recipient,
        uint256 _amount
    ) internal override {}

    function interchainSecurityModule()
        external
        view
        override
        returns (IInterchainSecurityModule)
    {
        return IInterchainSecurityModule(address(this));
    }

    /**
     * @notice Adds a new mapping between a Hyperlane domain and a Circle domain.
     * @param _hyperlaneDomain The Hyperlane domain.
     * @param _circleDomain The Circle domain.
     */
    function addDomain(
        uint32 _hyperlaneDomain,
        uint32 _circleDomain
    ) public onlyOwner {
        _domainMap[_hyperlaneDomain] = Domain(_hyperlaneDomain, _circleDomain);

        emit DomainAdded(_hyperlaneDomain, _circleDomain);
    }

    function addDomains(Domain[] memory domains) external onlyOwner {
        for (uint32 i = 0; i < domains.length; i++) {
            addDomain(domains[i].hyperlane, domains[i].circle);
        }
    }

    function hyperlaneDomainToCircleDomain(
        uint32 _hyperlaneDomain
    ) public view returns (uint32) {
        Domain memory domain = _domainMap[_hyperlaneDomain];
        require(
            domain.hyperlane == _hyperlaneDomain,
            "Circle domain not configured"
        );

        return domain.circle;
    }

    function _getCCTPVersion() internal pure virtual returns (uint32);

    function _getCircleRecipient(
        bytes29 cctpMessage
    ) internal pure virtual returns (address);

    function _getCircleSource(
        bytes29 cctpMessage
    ) internal pure virtual returns (uint32);

    function _getCircleNonce(
        bytes29 cctpMessage
    ) internal pure virtual returns (bytes32);

    function _validateTokenMessage(
        bytes calldata hyperlaneMessage,
        bytes29 cctpMessage
    ) internal pure virtual;

    function _validateHookMessage(
        bytes calldata hyperlaneMessage,
        bytes29 cctpMessage
    ) internal view virtual;

    function _sendMessageIdToIsm(
        uint32 destinationDomain,
        bytes32 ism,
        bytes32 messageId
    ) internal virtual;

    // @dev Enforces that the CCTP message source domain and nonce matches the Hyperlane message origin and nonce.
    function verify(
        bytes calldata _metadata,
        bytes calldata _hyperlaneMessage
    ) external returns (bool) {
        // decode return type of CctpService.getCCTPAttestation
        (bytes memory cctpMessageBytes, bytes memory attestation) = abi.decode(
            _metadata,
            (bytes, bytes)
        );

        bytes29 cctpMessage = TypedMemView.ref(cctpMessageBytes, 0);

        // check if CCTP message source matches the hyperlane message origin
        uint32 origin = _hyperlaneMessage.origin();
        uint32 sourceDomain = _getCircleSource(cctpMessage);
        require(
            sourceDomain == hyperlaneDomainToCircleDomain(origin),
            "Invalid source domain"
        );

        address circleRecipient = _getCircleRecipient(cctpMessage);
        // check if CCTP message is a USDC burn message
        if (circleRecipient == address(tokenMessenger)) {
            _validateTokenMessage(_hyperlaneMessage, cctpMessage);
        }
        // check if CCTP message is a GMP message to this contract
        else if (circleRecipient == address(this)) {
            _validateHookMessage(_hyperlaneMessage, cctpMessage);
        }
        // disallow other CCTP message destinations
        else {
            revert("Invalid circle recipient");
        }

        bytes32 nonce = _getCircleNonce(cctpMessage);
        // Receive only if the nonce hasn't been used before
        if (messageTransmitter.usedNonces(nonce) == 0) {
            require(
                messageTransmitter.receiveMessage(
                    cctpMessageBytes,
                    attestation
                ),
                "Failed to receive message"
            );
        }

        return true;
    }

    function _offchainLookupCalldata(
        bytes calldata _message
    ) internal pure override returns (bytes memory) {
        return abi.encodeCall(CctpService.getCCTPAttestation, (_message));
    }

    /// @inheritdoc IPostDispatchHook
    function hookType() external pure override returns (uint8) {
        return uint8(IPostDispatchHook.HookTypes.CCTP);
    }

    /// @inheritdoc IPostDispatchHook
    function supportsMetadata(
        bytes calldata /*metadata*/
    ) public pure override returns (bool) {
        return true;
    }

    /// @inheritdoc IPostDispatchHook
    function quoteDispatch(
        bytes calldata,
        bytes calldata
    ) external pure override returns (uint256) {
        return 0;
    }

    /// @inheritdoc IPostDispatchHook
    function postDispatch(
        bytes calldata /*metadata*/,
        bytes calldata message
    ) external payable override {
        bytes32 id = message.id();
        require(_isLatestDispatched(id), "Message not dispatched");

        uint32 destination = message.destination();
        bytes32 ism = _mustHaveRemoteRouter(destination);
        uint32 circleDestination = hyperlaneDomainToCircleDomain(destination);

        _sendMessageIdToIsm(circleDestination, ism, id);
    }

    function _bridgeViaCircle(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) internal virtual returns (bytes memory message) {}
}
