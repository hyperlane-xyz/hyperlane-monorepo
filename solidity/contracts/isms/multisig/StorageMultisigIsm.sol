// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {AbstractMultisigIsm} from "./AbstractMultisigIsm.sol";
import {AbstractMerkleRootMultisigIsm} from "./AbstractMerkleRootMultisigIsm.sol";
import {AbstractMessageIdMultisigIsm} from "./AbstractMessageIdMultisigIsm.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";

// ============ External Imports ============
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

abstract contract AbstractStorageMultisigIsm is AbstractMultisigIsm, Ownable {
    address[] public validators;
    uint8 public threshold;

    event ValidatorsAndThresholdSet(address[] validators, uint8 threshold);

    constructor(address[] memory _validators, uint8 _threshold) Ownable() {
        setValidatorsAndThreshold(_validators, _threshold);
    }

    function setValidatorsAndThreshold(
        address[] memory _validators,
        uint8 _threshold
    ) public onlyOwner {
        require(
            0 < _threshold && _threshold <= _validators.length,
            "Invalid threshold"
        );
        validators = _validators;
        threshold = _threshold;
        emit ValidatorsAndThresholdSet(_validators, _threshold);
    }

    function validatorsAndThreshold(
        bytes calldata /* _message */
    ) public view override returns (address[] memory, uint8) {
        return (validators, threshold);
    }
}

contract StorageMerkleRootMultisigIsm is
    AbstractMerkleRootMultisigIsm,
    AbstractStorageMultisigIsm
{
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.MERKLE_ROOT_MULTISIG);

    constructor(
        address[] memory _validators,
        uint8 _threshold
    ) AbstractStorageMultisigIsm(_validators, _threshold) {}
}

contract StorageMessageIdMultisigIsm is
    AbstractMessageIdMultisigIsm,
    AbstractStorageMultisigIsm
{
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.MESSAGE_ID_MULTISIG);

    constructor(
        address[] memory _validators,
        uint8 _threshold
    ) AbstractStorageMultisigIsm(_validators, _threshold) {}
}
