// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {IPredicateRegistry, Statement, Attestation} from "@predicate/interfaces/IPredicateRegistry.sol";

contract MockPredicateRegistry is IPredicateRegistry {
    mapping(address => string) public policies;
    mapping(string => bool) public usedUUIDs;

    bool public shouldValidate = true;
    bool public shouldRevert = false;
    string public revertMessage = "MockPredicateRegistry: validation failed";

    mapping(address => bool) public registeredAttesters;

    event PolicySet(address indexed client, string policy);
    event StatementValidated(
        address indexed msgSender,
        address indexed target,
        address indexed attester
    );

    function setShouldValidate(bool _shouldValidate) external {
        shouldValidate = _shouldValidate;
    }

    function setShouldRevert(
        bool _shouldRevert,
        string memory _message
    ) external {
        shouldRevert = _shouldRevert;
        revertMessage = _message;
    }

    function registerAttester(address _attester) external {
        registeredAttesters[_attester] = true;
    }

    function deregisterAttester(address _attester) external {
        registeredAttesters[_attester] = false;
    }

    function setPolicyID(string memory policyID) external override {
        policies[msg.sender] = policyID;
        emit PolicySet(msg.sender, policyID);
    }

    function getPolicyID(
        address client
    ) external view override returns (string memory) {
        return policies[client];
    }

    function validateAttestation(
        Statement memory _statement,
        Attestation memory _attestation
    ) external override returns (bool) {
        if (shouldRevert) {
            revert(revertMessage);
        }

        require(
            !usedUUIDs[_statement.uuid],
            "MockPredicateRegistry: UUID already used"
        );

        usedUUIDs[_statement.uuid] = true;

        emit StatementValidated(
            _statement.msgSender,
            _statement.target,
            _attestation.attester
        );

        return shouldValidate;
    }

    function markUUIDAsUsed(string memory uuid) external {
        usedUUIDs[uuid] = true;
    }
}
