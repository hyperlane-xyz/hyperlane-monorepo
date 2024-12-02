// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {OlympixUnitTest} from "./OlyTest.sol";
import {TestAttributeCheckpointFraud} from "../contracts/test/TestAttributeCheckpointFraud.sol";
import {FraudProofRouter} from "../contracts/middleware/FraudProofRouter.sol";
import {TestMailbox} from "../contracts/test/TestMailbox.sol";

contract FraudProofRouterTest is OlympixUnitTest("FraudProofRouterTest") {
    uint32 public constant LOCAL_DOMAIN = 1;
    TestAttributeCheckpointFraud public testAcf;
    FraudProofRouter public fpr;

    function setUp() public {
        TestMailbox testMailbox = new TestMailbox(LOCAL_DOMAIN);
        testAcf = new TestAttributeCheckpointFraud();

        fpr = new FraudProofRouter(address(testMailbox), address(testAcf));
    }
}

// import {Test} from "forge-std/Test.sol";

// contract FraudProofRouterTest is Test {
//     FraudProofRouter fraudProofRouter;
// }
