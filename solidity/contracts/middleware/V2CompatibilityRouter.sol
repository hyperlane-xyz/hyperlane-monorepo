// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Router} from "../Router.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {IMessageRecipient} from "../../interfaces/IMessageRecipient.sol";

/*
 * @title V2CompatabilityRouter
 * @dev You can use this middleware to deploy an app on v1 with the v2 interface
 */
contract V2CompatibilityRouter is Router {
    mapping(uint32 => uint32) v1ToV2Domain;
    mapping(uint32 => uint32) v2ToV1Domain;

    function initialize(
        address _owner,
        address _abacusConnectionManager,
        address _interchainGasPaymaster
    ) public initializer {
        // Transfer ownership of the contract to deployer
        _transferOwnership(_owner);
        // Set the addresses for the ACM and IGP
        _setAbacusConnectionManager(_abacusConnectionManager);
        _setInterchainGasPaymaster(_interchainGasPaymaster);
    }

    /**
     * @notice Adds a domain ID mapping from v1/v2 domain IDs and vice versa
     * @param _v1Domains An array of v1 domain IDs
     * @param _v2Domains An array of v2 domain IDs
     */
    function mapDomains(
        uint32[] calldata _v1Domains,
        uint32[] calldata _v2Domains
    ) external onlyOwner {
        for (uint256 i = 0; i < _v1Domains.length; i += 1) {
            v1ToV2Domain[_v1Domains[i]] = _v2Domains[i];
            v2ToV1Domain[_v2Domains[i]] = _v1Domains[i];
        }
    }

    /**
     * @notice Dispatches a message to the destination domain & recipient. Takes v2 domain IDs and translates them to v1 domainIds where necessary.
     * @param _v2Domain v2 Domain of destination chain
     * @param _recipientAddress Address of recipient on destination chain as bytes32
     * @param _messageBody Raw bytes content of message body
     * @return The message ID inserted into the Mailbox's merkle tree
     */
    function dispatch(
        uint32 _v2Domain,
        bytes32 _recipientAddress,
        bytes calldata _messageBody
    ) external returns (bytes32) {
        return
            bytes32(
                _dispatch(
                    getV1Domain(_v2Domain),
                    abi.encode(
                        TypeCasts.addressToBytes32(msg.sender),
                        _recipientAddress,
                        _messageBody
                    )
                )
            );
    }

    /**
     * @notice The internal Router `handle` function which just extracts the true recipient of the message and passes the translated v2 domain ID
     * @param _originV1Domain the origin domain as specified by the v1 Inbox
     * @param _sender The sender of the message which for middlewares is just the router on the origin chain
     * @param _message The wrapped message to include sender and recipient
     */
    function _handle(
        uint32 _originV1Domain,
        bytes32, // router sender
        bytes calldata _message
    ) internal override {
        (bytes32 _sender, bytes32 _recipient, bytes memory _messageBody) = abi
            .decode(_message, (bytes32, bytes32, bytes));

        IMessageRecipient(TypeCasts.bytes32ToAddress(_recipient)).handle(
            getV2Domain(_originV1Domain),
            _sender,
            _messageBody
        );
    }

    function getV1Domain(uint32 _v2Domain)
        public
        view
        returns (uint32 v1Domain)
    {
        v1Domain = v2ToV1Domain[_v2Domain];
        if (v1Domain == 0) {
            v1Domain = _v2Domain;
        }
    }

    function getV2Domain(uint32 _v1Domain)
        public
        view
        returns (uint32 v2Domain)
    {
        v2Domain = v1ToV2Domain[_v1Domain];
        if (v2Domain == 0) {
            v2Domain = _v1Domain;
        }
    }
}
