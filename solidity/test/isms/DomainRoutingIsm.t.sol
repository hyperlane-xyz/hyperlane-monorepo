// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import {DomainRoutingIsm} from "../../contracts/isms/routing/DomainRoutingIsm.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {MessageUtils, TestIsm} from "./IsmTestUtils.sol";

contract DomainRoutingIsmTest is Test {
    address constant nonOwner = 0xCAfEcAfeCAfECaFeCaFecaFecaFECafECafeCaFe;
    event ModuleSet(uint32 indexed domain, IInterchainSecurityModule module);
    DomainRoutingIsm ism;

    function setUp() public {
        ism = new DomainRoutingIsm();
    }

    function deployTestIsm(uint32 domain, bytes32 requiredMetadata)
        internal
        returns (TestIsm)
    {
        TestIsm testIsm = new TestIsm(abi.encode(requiredMetadata));
        ism.set(domain, testIsm);
        return testIsm;
    }

    function getMetadata(uint32 domain) private view returns (bytes memory) {
        return TestIsm(address(ism.modules(domain))).requiredMetadata();
    }

    function testSet(uint32 domain, IInterchainSecurityModule _ism) public {
        vm.expectEmit(true, true, false, true);
        emit ModuleSet(domain, _ism);
        ism.set(domain, _ism);
        assertEq(address(ism.modules(domain)), address(_ism));
    }

    function testSetNonOwner(uint32 domain, IInterchainSecurityModule _ism)
        public
    {
        vm.prank(nonOwner);
        vm.expectRevert("Ownable: caller is not the owner");
        ism.set(domain, _ism);
    }

    function testVerify(uint32 domain, bytes32 seed) public {
        deployTestIsm(domain, seed);

        bytes memory metadata = getMetadata(domain);
        assertTrue(ism.verify(metadata, MessageUtils.build(domain)));
    }

    function testVerifyNoIsm(uint32 domain, bytes32 seed) public {
        vm.assume(domain > 0);
        deployTestIsm(domain, seed);

        bytes memory metadata = getMetadata(domain);
        vm.expectRevert("No ISM found for origin domain");
        ism.verify(metadata, MessageUtils.build(domain - 1));
    }

    function testRoute(uint32 domain, bytes32 seed) public {
        TestIsm testIsm = deployTestIsm(domain, seed);
        assertEq(
            address(ism.route(MessageUtils.build(domain))),
            address(testIsm)
        );
    }
}
