// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import "forge-std/Test.sol";

import {ISlasher} from "../../contracts/interfaces/avs/vendored/ISlasher.sol";
import {TestAVSDirectory} from "../../contracts/test/avs/TestAVSDirectory.sol";
import {TestDelegationManager} from "../../contracts/test/avs/TestDelegationManager.sol";
import {TestSlasher} from "../../contracts/test/avs/TestSlasher.sol";

contract EigenlayerBase is Test {
    TestAVSDirectory internal avsDirectory;
    TestDelegationManager internal delegationManager;
    ISlasher internal slasher;

    function _deployMockEigenLayerAndAVS() internal {
        avsDirectory = new TestAVSDirectory();
        delegationManager = new TestDelegationManager();
        slasher = new TestSlasher();
    }
}
