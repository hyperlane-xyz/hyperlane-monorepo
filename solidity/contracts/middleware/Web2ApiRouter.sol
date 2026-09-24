// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ External Imports ============
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

// ============ Internal Imports ============
import {Router} from "../client/Router.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {PackageVersioned} from "../PackageVersioned.sol";
import {IWeb2ApiRouter} from "../interfaces/middleware/IWeb2ApiRouter.sol";
import {IWeb2Receiver} from "../interfaces/middleware/IWeb2Receiver.sol";
import {Web2Message} from "./libs/Web2Message.sol";

/**
 * @title Web2ApiRouter
 * @notice Router contract that facilitates bidirectional communication between on-chain smart contracts
 * and off-chain Web2 APIs using the Hyperlane Mailbox and ISM abstraction.
 */
contract Web2ApiRouter is Router, IWeb2ApiRouter {
    using TypeCasts for address;
    using TypeCasts for bytes32;
    using Web2Message for bytes;

    // ============ Public State ============
    uint32 public override web2Domain;
    uint256 private _requestNonce;

    // ============ Constructor ============
    constructor(address _mailbox, uint32 _web2Domain) Router(_mailbox) {
        web2Domain = _web2Domain;
    }

    // ============ Initializer ============
    function initialize(
        address _hook,
        address _interchainSecurityModule,
        address _owner,
        uint32 _web2Domain
    ) external initializer {
        _MailboxClient_initialize(_hook, _interchainSecurityModule, _owner);
        web2Domain = _web2Domain;
    }

    // ============ Owner Settings ============
    function setWeb2Domain(uint32 _newDomain) external onlyOwner {
        web2Domain = _newDomain;
    }

    // ============ External API Dispatch ============

    /**
     * @inheritdoc IWeb2ApiRouter
     */
    function requestApi(
        Web2Message.RequestParams calldata _params
    ) external payable override returns (bytes32 requestId, bytes32 messageId) {
        uint32 destDomain = _params.targetDomain == 0
            ? web2Domain
            : _params.targetDomain;
        bytes32 endpointHash = keccak256(bytes(_params.url));

        requestId = _generateRequestId();

        bytes memory messageBody = Web2Message.formatRequest(
            requestId,
            msg.sender.addressToBytes32(),
            _params
        );

        emit ApiRequestDispatched(
            requestId,
            destDomain,
            endpointHash,
            msg.sender,
            _params.url,
            _params.method
        );

        messageId = mailbox.dispatch{value: msg.value}(
            destDomain,
            endpointHash,
            messageBody,
            "",
            hook
        );
    }

    /**
     * @inheritdoc IWeb2ApiRouter
     */
    function quoteApiRequest(
        Web2Message.RequestParams calldata _params
    ) external view override returns (uint256 fee) {
        uint32 destDomain = _params.targetDomain == 0
            ? web2Domain
            : _params.targetDomain;
        bytes32 endpointHash = keccak256(bytes(_params.url));

        bytes memory messageBody = Web2Message.formatRequest(
            bytes32(0),
            msg.sender.addressToBytes32(),
            _params
        );

        return
            mailbox.quoteDispatch(
                destDomain,
                endpointHash,
                messageBody,
                "",
                hook
            );
    }

    // ============ Inbound Message Handling ============

    /**
     * @notice Handles incoming messages delivered by the Mailbox.
     */
    function handle(
        uint32 _origin,
        bytes32 _sender,
        bytes calldata _message
    ) external payable virtual override onlyMailbox {
        if (_origin == web2Domain) {
            _handle(_origin, _sender, _message);
        } else {
            bytes32 _router = _mustHaveRemoteRouter(_origin);
            require(
                _router == _sender,
                "Enrolled router does not match sender"
            );
            _handle(_origin, _sender, _message);
        }
    }

    /**
     * @notice Processes the decoded Web2 response and triggers the recipient callback.
     */
    function _handle(
        uint32 _origin,
        bytes32 _sender,
        bytes calldata _message
    ) internal virtual override {
        Web2Message.Response memory response = Web2Message.decodeResponse(
            _message
        );

        address recipient = response.callbackAddress.bytes32ToAddress();

        emit ApiResponseReceived(
            response.requestId,
            _origin,
            _sender,
            response.statusCode,
            recipient
        );

        if (recipient != address(0)) {
            IWeb2Receiver(recipient).handleWeb2Response{value: msg.value}(
                response.requestId,
                _origin,
                _sender,
                response.statusCode,
                response.responseBody,
                response.callbackData
            );
        }
    }

    // ============ Internal Helpers ============

    function _generateRequestId() internal returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(
                    block.chainid,
                    address(this),
                    msg.sender,
                    _requestNonce++,
                    block.timestamp
                )
            );
    }
}
