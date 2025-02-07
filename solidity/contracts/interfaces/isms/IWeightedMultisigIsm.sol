// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

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

import {IInterchainSecurityModule} from "../IInterchainSecurityModule.sol";

interface IStaticWeightedMultisigIsm is IInterchainSecurityModule {
    // ============ Structs ============

    // ValidatorInfo contains the signing address and weight of a validator
    struct ValidatorInfo {
        address signingAddress;
        uint96 weight;
    }

    /**
     * @notice Returns the validators and threshold weight for this ISM.
     * @param _message The message to be verified
     * @return validators The validators and their weights
     * @return thresholdWeight The threshold weight required to pass verification
     */
    function validatorsAndThresholdWeight(
        bytes calldata _message
    )
        external
        view
        returns (ValidatorInfo[] memory validators, uint96 thresholdWeight);
}
