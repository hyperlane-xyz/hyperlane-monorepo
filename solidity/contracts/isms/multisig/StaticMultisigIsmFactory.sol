// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;
// ============ Internal Imports ============
import {AbstractMultisigIsm} from "./AbstractMultisigIsm.sol";
import {AbstractMerkleRootMultisigIsm} from "./AbstractMerkleRootMultisigIsm.sol";
import {AbstractMessageIdMultisigIsm} from "./AbstractMessageIdMultisigIsm.sol";
import {MetaProxy} from "../../libs/MetaProxy.sol";
import {StaticMOfNAddressSetFactory} from "../../libs/StaticMOfNAddressSetFactory.sol";

/**
 * @title AbstractMetaProxyMultisigIsm
 * @notice Manages per-domain m-of-n Validator sets that are used
 * to verify interchain messages.
 */
abstract contract AbstractMetaProxyMultisigIsm is AbstractMultisigIsm {
    /**
     * @inheritdoc AbstractMultisigIsm
     */
    function validatorsAndThreshold(bytes calldata)
        public
        pure
        override
        returns (address[] memory, uint8)
    {
        return abi.decode(MetaProxy.metadata(), (address[], uint8));
    }
}

contract StaticMerkleRootMultisigIsm is
    AbstractMerkleRootMultisigIsm,
    AbstractMetaProxyMultisigIsm
{}

contract StaticMerkleRootMultisigIsmFactory is StaticMOfNAddressSetFactory {
    function _deployImplementation() internal override returns (address) {
        return address(new StaticMerkleRootMultisigIsm());
    }
}

contract StaticMessageIdMultisigIsm is
    AbstractMessageIdMultisigIsm,
    AbstractMetaProxyMultisigIsm
{}

contract StaticMessageIdMultisigIsmFactory is StaticMOfNAddressSetFactory {
    function _deployImplementation() internal override returns (address) {
        return address(new StaticMessageIdMultisigIsm());
    }
}
