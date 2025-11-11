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
import {AbstractStaticWeightedMultisigIsm} from "./AbstractWeightedMultisigIsm.sol";
import {StaticWeightedValidatorSetFactory} from "../../libs/StaticWeightedValidatorSetFactory.sol";
import {MetaProxy} from "../../libs/MetaProxy.sol";

abstract contract AbstractMetaProxyWeightedMultisigIsm is
    AbstractStaticWeightedMultisigIsm
{
    /**
     * @inheritdoc AbstractStaticWeightedMultisigIsm
     */
    function validatorsAndThresholdWeight(
        bytes calldata /* _message*/
    ) public pure override returns (ValidatorInfo[] memory, uint96) {
        return abi.decode(MetaProxy.metadata(), (ValidatorInfo[], uint96));
    }
}

contract StaticMerkleRootWeightedMultisigIsm is
    AbstractMerkleRootMultisigIsm,
    AbstractMetaProxyWeightedMultisigIsm
{
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.WEIGHTED_MERKLE_ROOT_MULTISIG);
}

contract StaticMessageIdWeightedMultisigIsm is
    AbstractMessageIdMultisigIsm,
    AbstractMetaProxyWeightedMultisigIsm
{
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.WEIGHTED_MESSAGE_ID_MULTISIG);
}

contract StaticMerkleRootWeightedMultisigIsmFactory is
    StaticWeightedValidatorSetFactory
{
    function _deployImplementation() internal override returns (address) {
        return address(new StaticMerkleRootWeightedMultisigIsm());
    }
}

contract StaticMessageIdWeightedMultisigIsmFactory is
    StaticWeightedValidatorSetFactory
{
    function _deployImplementation() internal override returns (address) {
        return address(new StaticMessageIdWeightedMultisigIsm());
    }
}
