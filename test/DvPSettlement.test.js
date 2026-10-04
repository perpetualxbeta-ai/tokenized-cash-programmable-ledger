const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");
const { ledgerFixture, cash, ref } = require("./fixture");

const DAY = 24 * 60 * 60;

async function dvpFixture() {
  const f = await ledgerFixture();
  const { token, bond, dvp, bank, corp } = f;
  // bank holds bonds and sells them to corp for cash
  await bond.mint(bank.address, 100);
  const dvpAddr = await dvp.getAddress();
  await bond.connect(bank).approve(dvpAddr, ethers.MaxUint256);
  await token.connect(corp).approve(dvpAddr, ethers.MaxUint256);
  const deadline = (await time.latest()) + DAY;
  const bondAddr = await bond.getAddress();
  await dvp.connect(bank).propose(bank.address, corp.address, bondAddr, 10, cash(10_250), deadline, ref("TRADE-1"));
  return { ...f, id: 1n, deadline, bondAddr };
}

describe("DvPSettlement", () => {
  it("D-01 settles both legs atomically when the counterparty affirms", async () => {
    const { dvp, token, bond, bank, corp, id } = await loadFixture(dvpFixture);
    const tx = dvp.connect(corp).settle(id);
    await expect(tx).to.emit(dvp, "TradeSettled").withArgs(id);
    await expect(tx).to.changeTokenBalances(token, [bank, corp], [cash(10_250), -cash(10_250)]);
    expect(await bond.balanceOf(corp.address)).to.equal(10);
    expect(await bond.balanceOf(bank.address)).to.equal(90);
  });

  it("D-02 the proposer cannot settle their own proposal", async () => {
    const { dvp, bank, id } = await loadFixture(dvpFixture);
    await expect(dvp.connect(bank).settle(id)).to.be.revertedWithCustomError(dvp, "Unauthorized");
  });

  it("D-03 if the cash leg fails, the asset leg is rolled back too", async () => {
    const { dvp, token, bond, bank, corp, id } = await loadFixture(dvpFixture);
    await token.freeze(corp.address, ref("sanctions-hit"));
    await expect(dvp.connect(corp).settle(id)).to.be.reverted;
    expect(await bond.balanceOf(bank.address)).to.equal(100);
    expect(await bond.balanceOf(corp.address)).to.equal(0);
  });

  it("D-04 if the asset leg fails (seller short), no cash moves", async () => {
    const { dvp, token, bond, bank, corp, bob, id } = await loadFixture(dvpFixture);
    await bond.connect(bank).transfer(bob.address, 95); // seller now only has 5
    const before = await token.balanceOf(corp.address);
    await expect(dvp.connect(corp).settle(id)).to.be.reverted;
    expect(await token.balanceOf(corp.address)).to.equal(before);
  });

  it("D-05 expired or cancelled trades cannot settle", async () => {
    const { dvp, bank, corp, id, deadline, bondAddr } = await loadFixture(dvpFixture);
    await time.increaseTo(deadline);
    await expect(dvp.connect(corp).settle(id)).to.be.revertedWithCustomError(dvp, "Expired");
    const d2 = (await time.latest()) + DAY;
    await dvp.connect(corp).propose(bank.address, corp.address, bondAddr, 1, cash(1_000), d2, ref("T2"));
    await dvp.connect(bank).cancel(2);
    await expect(dvp.connect(bank).settle(2)).to.be.revertedWithCustomError(dvp, "InvalidStatus");
  });

  it("D-06 only the two parties can propose or cancel", async () => {
    const { dvp, bank, corp, stranger, id, bondAddr } = await loadFixture(dvpFixture);
    const d = (await time.latest()) + DAY;
    await expect(dvp.connect(stranger).propose(bank.address, corp.address, bondAddr, 1, 1, d, ref("x"))).to.be.revertedWithCustomError(dvp, "Unauthorized");
    await expect(dvp.connect(stranger).cancel(id)).to.be.revertedWithCustomError(dvp, "Unauthorized");
  });

  it("D-07 the asset is permissioned: unregistered buyers cannot receive it", async () => {
    const { dvp, bond, bank, stranger, bondAddr } = await loadFixture(dvpFixture);
    const d = (await time.latest()) + DAY;
    await dvp.connect(bank).propose(bank.address, stranger.address, bondAddr, 1, 1, d, ref("x"));
    await expect(dvp.connect(stranger).settle(2)).to.be.revertedWithCustomError(bond, "NotAllowed");
  });
});
