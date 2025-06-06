// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import "forge-std/Test.sol";
import "../../contracts/test/TestCcipReadIsm.sol";

contract TestCcipReadIsmTest is Test {
    TestCcipReadIsm internal ism;
    string[] internal urls;

    function setUp() public {
        // Initialize with a single URL (actual value not used in Test contract)
        urls = new string[](1);
        urls[0] = "http://example.com/{data}";
        ism = new TestCcipReadIsm(urls);
    }

    function testGetOffchainVerifyInfoRevertsWithOffchainLookup() public {
        bytes memory message = hex"1234";
        vm.expectRevert(
            abi.encodeWithSelector(
                OffchainLookup.selector,
                address(ism),
                urls,
                ism.calldataToReturn(),
                bytes4(0),
                ""
            )
        );
        ism.getOffchainVerifyInfo(message);
    }

    function testVerifyReturnsTrueOnValidMetadata() public {
        // Encode a boolean 'true' as metadata
        bytes memory metadata = abi.encode(true);
        bool result = ism.verify(metadata, "");
        assertTrue(
            result,
            "Expected verify() to return true for valid metadata"
        );
    }

    function testVerifyRevertsOnInvalidMetadata() public {
        // Encode a boolean 'false' as metadata
        bytes memory invalid = abi.encode(false);
        vm.expectRevert("TestCcipReadIsm: invalid metadata");
        ism.verify(invalid, "");
    }
}
