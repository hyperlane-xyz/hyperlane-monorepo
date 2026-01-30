// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import {IncrementalDomainRoutingIsm} from "../../contracts/isms/routing/IncrementalDomainRoutingIsm.sol";
import {IncrementalDomainRoutingIsmFactory} from "../../contracts/isms/routing/IncrementalDomainRoutingIsmFactory.sol";
import {DomainRoutingIsmTest} from "./DomainRoutingIsm.t.sol";
import {IInterchainSecurityModule} from "../../contracts/interfaces/IInterchainSecurityModule.sol";
import {TestIsm} from "./IsmTestUtils.sol";

contract IncrementalDomainRoutingIsmTest is DomainRoutingIsmTest {
    function setUp() public override {
        ism = new IncrementalDomainRoutingIsm();
        ism.initialize(address(this));
    }

    // Override the base test since IncrementalDomainRoutingIsm doesn't support removal
    function testRemove(uint32 domain) public virtual override {
        // Remove should always revert, even for non-existent domains
        vm.expectRevert("IncrementalDomainRoutingIsm: removal not supported");
        ism.remove(domain);

        // Set a domain and try to remove it - should still revert
        TestIsm _ism = deployTestIsm(bytes32(0));
        ism.set(domain, _ism);

        vm.expectRevert("IncrementalDomainRoutingIsm: removal not supported");
        ism.remove(domain);
    }

    function testSetTwiceReverts(uint32 domain) public {
        TestIsm _ism = deployTestIsm(bytes32(0));
        TestIsm _ism2 = deployTestIsm(bytes32(uint256(1)));

        // First set should succeed
        ism.set(domain, _ism);
        assertEq(address(ism.module(domain)), address(_ism));

        // Second set should revert
        vm.expectRevert();
        ism.set(domain, _ism2);

        // Domain should still have the first ISM
        assertEq(address(ism.module(domain)), address(_ism));
    }

    function testRemoveAlwaysReverts(uint32 domain) public {
        TestIsm _ism = deployTestIsm(bytes32(0));

        // Set a domain
        ism.set(domain, _ism);
        assertEq(address(ism.module(domain)), address(_ism));

        // Attempting to remove should always revert
        vm.expectRevert("IncrementalDomainRoutingIsm: removal not supported");
        ism.remove(domain);

        // Domain should still exist
        assertEq(address(ism.module(domain)), address(_ism));
    }

    function testRemoveNonExistentDomainReverts(uint32 domain) public {
        // Attempting to remove a non-existent domain should also revert
        vm.expectRevert("IncrementalDomainRoutingIsm: removal not supported");
        ism.remove(domain);
    }

    function testInitializeWithDuplicateDomains() public {
        uint32[] memory _domains = new uint32[](2);
        IInterchainSecurityModule[]
            memory _isms = new IInterchainSecurityModule[](2);

        _domains[0] = 1;
        _domains[1] = 1; // Duplicate domain
        _isms[0] = deployTestIsm(bytes32(0));
        _isms[1] = deployTestIsm(bytes32(uint256(1)));

        IncrementalDomainRoutingIsm newIsm = new IncrementalDomainRoutingIsm();

        // Should revert when trying to initialize with duplicate domains
        vm.expectRevert();
        newIsm.initialize(address(this), _domains, _isms);
    }

    function testFactoryDeploy(uint8 count, uint32 domain) public {
        vm.assume(domain > count);
        vm.assume(count > 0);

        IncrementalDomainRoutingIsmFactory factory = new IncrementalDomainRoutingIsmFactory();
        uint32[] memory _domains = new uint32[](count);
        IInterchainSecurityModule[]
            memory _isms = new IInterchainSecurityModule[](count);

        for (uint32 i = 0; i < count; ++i) {
            _domains[i] = domain - i;
            _isms[i] = deployTestIsm(bytes32(uint256(i)));
        }

        IncrementalDomainRoutingIsm deployed = IncrementalDomainRoutingIsm(
            address(factory.deploy(address(this), _domains, _isms))
        );

        // Verify all domains were set correctly
        for (uint256 i = 0; i < count; ++i) {
            assertEq(address(deployed.module(_domains[i])), address(_isms[i]));
        }

        // Verify we can't set an existing domain
        TestIsm newIsm = deployTestIsm(bytes32(uint256(count)));
        vm.expectRevert();
        deployed.set(_domains[0], newIsm);
    }

    function testFactoryDeployWithDuplicates() public {
        IncrementalDomainRoutingIsmFactory factory = new IncrementalDomainRoutingIsmFactory();
        uint32[] memory _domains = new uint32[](2);
        IInterchainSecurityModule[]
            memory _isms = new IInterchainSecurityModule[](2);

        _domains[0] = 1;
        _domains[1] = 1; // Duplicate
        _isms[0] = deployTestIsm(bytes32(0));
        _isms[1] = deployTestIsm(bytes32(uint256(1)));

        // Should revert when deploying with duplicate domains
        vm.expectRevert();
        factory.deploy(address(this), _domains, _isms);
    }

    function testFactoryImplementation() public {
        IncrementalDomainRoutingIsmFactory factory = new IncrementalDomainRoutingIsmFactory();
        address impl = factory.implementation();

        // Implementation should be an IncrementalDomainRoutingIsm
        assertFalse(impl == address(0));

        // Verify it's a valid contract
        assertTrue(impl.code.length > 0);
    }
}
