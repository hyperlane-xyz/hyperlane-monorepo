// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/*@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
     @@@@@  HYPERLANE  @@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
@@@@@@@@@       @@@@@@@@*/

import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {AbstractMerkleRootMultisigIsm} from "./AbstractMerkleRootMultisigIsm.sol";
import {AbstractMessageIdMultisigIsm} from "./AbstractMessageIdMultisigIsm.sol";
import {AbstractStaticWeightedMultisigIsm, AbstractWeightedMultisigIsm} from "./AbstractWeightedMultisigIsm.sol";
import {AbstractMultisigIsm} from "./AbstractMultisigIsm.sol";
import {StaticThresholdAddressSetFactory} from "../../libs/StaticAddressSetFactory.sol";
import {MetaProxy} from "../../libs/MetaProxy.sol";

abstract contract AbstractMetaProxyMultisigIsm is
    AbstractStaticWeightedMultisigIsm
{
    /**
     * @inheritdoc AbstractStaticWeightedMultisigIsm
     */
    function validatorsAndThresholdWeight(
        bytes calldata /* _message*/
    ) public pure override returns (ValidatorInfo[] memory, uint96) {
        return abi.decode(MetaProxy.metadata(), (ValidatorInfo[], uint8));
    }
}

contract MerkleRootStaticWeightedMultisigIsm is
    AbstractMerkleRootMultisigIsm,
    AbstractMetaProxyMultisigIsm
{
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.WEIGHT_MERKLE_ROOT_MULTISIG);
}

contract MerkleRootWeightedMultisigIsm is
    AbstractMerkleRootMultisigIsm,
    AbstractWeightedMultisigIsm
{
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.WEIGHT_MESSAGE_ID_MULTISIG);
}

contract MessageIdStaticWeightedMultisigIsm is
    AbstractMessageIdMultisigIsm,
    AbstractMetaProxyMultisigIsm
{
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.WEIGHT_MESSAGE_ID_MULTISIG);
}

contract MessageIdWeightedMultisigIsm is
    AbstractMessageIdMultisigIsm,
    AbstractWeightedMultisigIsm
{
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.WEIGHT_MESSAGE_ID_MULTISIG);
}

contract StaticMerkleRootWeightedMultisigIsmFactory is
    StaticThresholdAddressSetFactory
{
    function _deployImplementation() internal override returns (address) {
        return address(new MerkleRootStaticWeightedMultisigIsm());
    }
}

contract StaticMessageIdWeightedMultisigIsmFactory is
    StaticThresholdAddressSetFactory
{
    function _deployImplementation() internal override returns (address) {
        return address(new MessageIdStaticWeightedMultisigIsm());
    }
}
