// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import {DomainRoutingIsm} from "../../contracts/isms/routing/DomainRoutingIsm.sol";
import {DomainRoutingIsmFactory} from "../../contracts/isms/routing/DomainRoutingIsmFactory.sol";
import {IInterchainSecurityModule} from "../../contracts/interfaces/IInterchainSecurityModule.sol";
import {MessageUtils, TestIsm} from "./IsmTestUtils.sol";

contract DomainRoutingIsmTest is Test {
    address constant nonOwner = 0xCAfEcAfeCAfECaFeCaFecaFecaFECafECafeCaFe;
    event ModuleSet(uint32 indexed domain, IInterchainSecurityModule module);
    DomainRoutingIsm ism;

    function setUp() public {
        ism = new DomainRoutingIsm();
        ism.initialize(address(this));
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

    function testSet(uint32 domain) public {
        TestIsm _ism = deployTestIsm(domain, bytes32(0));
        vm.expectEmit(true, true, false, true);
        emit ModuleSet(domain, _ism);
        ism.set(domain, _ism);
        assertEq(address(ism.modules(domain)), address(_ism));
    }

    function testSetManyViaFactory(uint8 count, uint32 domain) public {
        vm.assume(domain > count);
        DomainRoutingIsmFactory factory = new DomainRoutingIsmFactory();
        uint32[] memory _domains = new uint32[](count);
        IInterchainSecurityModule[]
            memory _isms = new IInterchainSecurityModule[](count);
        for (uint32 i = 0; i < count; ++i) {
            _domains[i] = domain - i;
            _isms[i] = deployTestIsm(_domains[i], bytes32(0));
            vm.expectEmit(true, true, false, true);
            emit ModuleSet(_domains[i], _isms[i]);
        }
        ism = factory.deploy(_domains, _isms);
        for (uint256 i = 0; i < count; ++i) {
            assertEq(address(ism.modules(_domains[i])), address(_isms[i]));
        }
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
