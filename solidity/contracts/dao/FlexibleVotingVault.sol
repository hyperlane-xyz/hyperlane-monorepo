// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {IVault} from "symbiotic-core/src/interfaces/vault/IVault.sol";

import {FlexVotingClient} from "flexible-voting/src/FlexVotingClient.sol";

contract FlexibleVotingVault is FlexVotingClient {
    IVault public immutable vault;

    constructor(address _vault, address _governor) FlexVotingClient(_governor) {
        vault = IVault(_vault);
    }

    function _rawBalanceOf(
        address _user
    ) internal view override returns (uint256) {
        return vault.activeBalanceOf(_user);
    }
}
