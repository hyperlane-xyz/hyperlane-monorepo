// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {AbstractMerkleRootMultisigIsm} from "./AbstractMerkleRootMultisigIsm.sol";
import {AbstractMessageIdMultisigIsm} from "./AbstractMessageIdMultisigIsm.sol";
import {AbstractWeightedMultisigIsm} from "./AbstractWeightedMultisigIsm.sol";
import {AbstractMultisigIsm} from "./AbstractMultisigIsm.sol";
import {StaticThresholdAddressSetFactory} from "../../libs/StaticAddressSetFactory.sol";

// solhint-disable no-empty-blocks

/**
 * @title StaticMerkleRootMultisigIsm
 * @notice Manages per-domain m-of-n validator set that is used
 * to verify interchain messages using a merkle root signature quorum
 * and merkle proof of inclusion.
 */
contract MerkleRootWeightedMultisigIsm is
    AbstractWeightedMultisigIsm,
    AbstractMerkleRootMultisigIsm
{
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.WEIGHT_MERKLE_ROOT_MULTISIG);
}

/**
 * @title StaticMessageIdMultisigIsm
 * @notice Manages per-domain m-of-n validator set that is used
 * to verify interchain messages using a message ID signature quorum.
 */
contract MessageIdWeightedMultisigIsm is
    AbstractMessageIdMultisigIsm,
    AbstractWeightedMultisigIsm
{
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.WEIGHT_MESSAGE_ID_MULTISIG);
}

contract StaticMerkleRootMultisigIsmFactory is
    StaticThresholdAddressSetFactory
{
    function _deployImplementation() internal override returns (address) {
        return address(new MerkleRootWeightedMultisigIsm());
    }
}

contract StaticMessageIdMultisigIsmFactory is StaticThresholdAddressSetFactory {
    function _deployImplementation() internal override returns (address) {
        return address(new MessageIdWeightedMultisigIsm());
    }
}
