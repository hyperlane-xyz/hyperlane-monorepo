// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;
// ============ Internal Imports ============

import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {AbstractMultisigIsm} from "./AbstractMultisigIsm.sol";
import {AbstractMerkleRootMultisigIsm} from "./AbstractMerkleRootMultisigIsm.sol";
import {AbstractMessageIdMultisigIsm} from "./AbstractMessageIdMultisigIsm.sol";
import {MetaProxy} from "../../libs/MetaProxy.sol";
import {StaticThresholdAddressSetFactory} from "../../libs/StaticAddressSetFactory.sol";

/**
 * @title AbstractMetaProxyMultisigIsm
 * @notice Manages per-domain m-of-n Validator set that is used
 * to verify interchain messages.
 */
abstract contract AbstractMetaProxyMultisigIsm is AbstractMultisigIsm {
    /**
     * @inheritdoc AbstractMultisigIsm
     */
    function validatorsAndThreshold(
        bytes calldata
    ) public pure override returns (address[] memory, uint8) {
        return abi.decode(MetaProxy.metadata(), (address[], uint8));
    }
}

// solhint-disable no-empty-blocks

/**
 * @title StaticMerkleRootMultisigIsm
 * @notice Manages per-domain m-of-n validator set that is used
 * to verify interchain messages using a merkle root signature quorum
 * and merkle proof of inclusion.
 */
contract StaticMerkleRootMultisigIsm is
    AbstractMerkleRootMultisigIsm,
    AbstractMetaProxyMultisigIsm
{
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.MERKLE_ROOT_MULTISIG);
}

/**
 * @title StaticMessageIdMultisigIsm
 * @notice Manages per-domain m-of-n validator set that is used
 * to verify interchain messages using a message ID signature quorum.
 */
contract StaticMessageIdMultisigIsm is
    AbstractMessageIdMultisigIsm,
    AbstractMetaProxyMultisigIsm
{
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.MESSAGE_ID_MULTISIG);
}

// solhint-enable no-empty-blocks

contract StaticMerkleRootMultisigIsmFactory is
    StaticThresholdAddressSetFactory
{
    function _deployImplementation() internal override returns (address) {
        return address(new StaticMerkleRootMultisigIsm());
    }
}

contract StaticMessageIdMultisigIsmFactory is StaticThresholdAddressSetFactory {
    function _deployImplementation() internal override returns (address) {
        return address(new StaticMessageIdMultisigIsm());
    }
}
