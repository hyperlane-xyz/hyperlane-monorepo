import { ethers, abacus } from "hardhat";
import { expect } from "chai";

import {
  TestHome__factory,
  TestReplica__factory,
  TestXAppConnectionManager,
  TestXAppConnectionManager__factory,
  TestReplica,
} from "../typechain";
import { Updater } from "./lib/core";
import { Signer } from "./lib/types";

const signedFailureTestCases = require("../../../vectors/signedFailure.json");

const ONLY_OWNER_REVERT_MSG = "Ownable: caller is not the owner";
const localDomain = 1000;
const remoteDomain = 2000;
const processGas = 850000;
const reserveGas = 15000;
const optimisticSeconds = 3;

describe("XAppConnectionManager", async () => {
  let connectionManager: TestXAppConnectionManager,
    enrolledReplica: TestReplica,
    signer: Signer,
    updater: Updater;

  before(async () => {
    [signer] = await ethers.getSigners();
    updater = await Updater.fromSigner(signer, localDomain);
  });

  beforeEach(async () => {
    const homeFactory = new TestHome__factory(signer);
    const home = await homeFactory.deploy(localDomain);

    const replicaFactory = new TestReplica__factory(signer);
    enrolledReplica = await replicaFactory.deploy(
      localDomain,
      processGas,
      reserveGas
    );
    await enrolledReplica.initialize(
      remoteDomain,
      updater.address,
      ethers.constants.HashZero,
      optimisticSeconds
    );

    const connectionManagerFactory = new TestXAppConnectionManager__factory(
      signer
    );
    connectionManager = await connectionManagerFactory.deploy();
    await connectionManager.setHome(home.address);
    await connectionManager.ownerEnrollReplica(
      enrolledReplica.address,
      remoteDomain
    );
  });

  it("Returns the local domain", async () => {
    expect(await connectionManager!.localDomain()).to.equal(localDomain);
  });

  it("onlyOwner function rejects call from non-owner", async () => {
    const [nonHome, nonOwner] = await ethers.getSigners();
    await expect(
      connectionManager.connect(nonOwner).setHome(nonHome.address)
    ).to.be.revertedWith(ONLY_OWNER_REVERT_MSG);
  });

  it("isReplica returns true for enrolledReplica and false for non-enrolled Replica", async () => {
    const [nonEnrolledReplica] = await ethers.getSigners();
    expect(await connectionManager.isReplica(enrolledReplica.address)).to.be
      .true;
    expect(await connectionManager.isReplica(nonEnrolledReplica.address)).to.be
      .false;
  });

  it("Allows owner to set the home", async () => {
    const homeFactory = new TestHome__factory(signer);
    const newHome = await homeFactory.deploy(localDomain);

    await connectionManager.setHome(newHome.address);
    expect(await connectionManager.home()).to.equal(newHome.address);
  });

  it("Owner can enroll a new replica", async () => {
    const newRemoteDomain = 3000;
    const replicaFactory = new TestReplica__factory(signer);
    const newReplica = await replicaFactory.deploy(
      localDomain,
      processGas,
      reserveGas
    );

    // Assert new replica not considered replica before enrolled
    expect(await connectionManager.isReplica(newReplica.address)).to.be.false;

    await expect(
      connectionManager.ownerEnrollReplica(newReplica.address, newRemoteDomain)
    ).to.emit(connectionManager, "ReplicaEnrolled");

    expect(await connectionManager.domainToReplica(newRemoteDomain)).to.equal(
      newReplica.address
    );
    expect(
      await connectionManager.replicaToDomain(newReplica.address)
    ).to.equal(newRemoteDomain);
    expect(await connectionManager.isReplica(newReplica.address)).to.be.true;
  });

  it("Owner can unenroll a replica", async () => {
    await expect(
      connectionManager.ownerUnenrollReplica(enrolledReplica.address)
    ).to.emit(connectionManager, "ReplicaUnenrolled");

    expect(
      await connectionManager.replicaToDomain(enrolledReplica.address)
    ).to.equal(0);
    expect(await connectionManager.domainToReplica(localDomain)).to.equal(
      ethers.constants.AddressZero
    );
    expect(await connectionManager.isReplica(enrolledReplica.address)).to.be
      .false;
  });

  it("Owner can set watcher permissions", async () => {
    const [watcher] = await ethers.getSigners();
    expect(
      await connectionManager.watcherPermission(watcher.address, remoteDomain)
    ).to.be.false;

    await expect(
      connectionManager.setWatcherPermission(
        watcher.address,
        remoteDomain,
        true
      )
    ).to.emit(connectionManager, "WatcherPermissionSet");

    expect(
      await connectionManager.watcherPermission(watcher.address, remoteDomain)
    ).to.be.true;
  });

  it("Unenrolls a replica given valid SignedFailureNotification", async () => {
    // Set watcher permissions for domain of currently enrolled replica
    const [watcher] = await ethers.getSigners();
    await connectionManager.setWatcherPermission(
      watcher.address,
      remoteDomain,
      true
    );

    // Create signed failure notification and signature
    const { failureNotification, signature } =
      await abacus.signedFailureNotification(
        watcher,
        remoteDomain,
        await updater.signer.getAddress()
      );

    // Assert new replica considered replica before unenrolled
    expect(await connectionManager.isReplica(enrolledReplica.address)).to.be
      .true;

    // Unenroll replica using data + signature
    await expect(
      connectionManager.unenrollReplica(
        failureNotification.domain,
        failureNotification.updaterBytes32,
        signature
      )
    ).to.emit(connectionManager, "ReplicaUnenrolled");

    expect(
      await connectionManager.replicaToDomain(enrolledReplica.address)
    ).to.equal(0);
    expect(await connectionManager.domainToReplica(localDomain)).to.equal(
      ethers.constants.AddressZero
    );
    expect(await connectionManager.isReplica(enrolledReplica.address)).to.be
      .false;
  });

  it("unenrollReplica reverts if there is no replica for provided domain", async () => {
    const noReplicaDomain = 3000;

    // Set watcher permissions for noReplicaDomain
    const [watcher] = await ethers.getSigners();
    await connectionManager.setWatcherPermission(
      watcher.address,
      noReplicaDomain,
      true
    );

    // Create signed failure notification and signature for noReplicaDomain
    const { failureNotification, signature } =
      await abacus.signedFailureNotification(
        watcher,
        noReplicaDomain,
        await updater.signer.getAddress()
      );

    // Expect unenrollReplica call to revert
    await expect(
      connectionManager.unenrollReplica(
        failureNotification.domain,
        failureNotification.updaterBytes32,
        signature
      )
    ).to.be.revertedWith("!replica exists");
  });

  it("unenrollReplica reverts if provided updater does not match replica updater", async () => {
    const [watcher, nonUpdater] = await ethers.getSigners();

    // Set watcher permissions
    await connectionManager.setWatcherPermission(
      watcher.address,
      remoteDomain,
      true
    );

    // Create signed failure notification and signature with nonUpdater
    const { failureNotification, signature } =
      await abacus.signedFailureNotification(
        watcher,
        remoteDomain,
        nonUpdater.address
      );

    // Expect unenrollReplica call to revert
    await expect(
      connectionManager.unenrollReplica(
        failureNotification.domain,
        failureNotification.updaterBytes32,
        signature
      )
    ).to.be.revertedWith("!current updater");
  });

  it("unenrollReplica reverts if incorrect watcher provided", async () => {
    const [watcher, nonWatcher] = await ethers.getSigners();

    // Set watcher permissions
    await connectionManager.setWatcherPermission(
      watcher.address,
      remoteDomain,
      true
    );

    // Create signed failure notification and signature with nonWatcher
    const { failureNotification, signature } =
      await abacus.signedFailureNotification(
        nonWatcher,
        remoteDomain,
        await updater.signer.getAddress()
      );

    // Expect unenrollReplica call to revert
    await expect(
      connectionManager.unenrollReplica(
        failureNotification.domain,
        failureNotification.updaterBytes32,
        signature
      )
    ).to.be.revertedWith("!valid watcher");
  });

  it("Checks Rust-produced SignedFailureNotification", async () => {
    // Compare Rust output in json file to solidity output
    const testCase = signedFailureTestCases[0];
    const { domain, updater, signature, signer } = testCase;

    await enrolledReplica.setUpdater(updater);
    await connectionManager.setWatcherPermission(signer, domain, true);

    // Just performs signature recovery (not dependent on replica state, just
    // tests functionality)
    const watcher = await connectionManager.testRecoverWatcherFromSig(
      domain,
      enrolledReplica.address,
      updater,
      ethers.utils.joinSignature(signature)
    );

    expect(watcher.toLowerCase()).to.equal(signer);
  });
});
