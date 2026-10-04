const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");
const { ledgerFixture, cash, ref } = require("./fixture");

const DAY = 24 * 60 * 60;

async function pbmFixture() {
  const f = await ledgerFixture();
  const { token, pbm, corp, alice, bob, merchant } = f;
  // corp acts as the sponsor (think: a government agency or an employer benefit scheme)
  await token.connect(corp).approve(await pbm.getAddress(), ethers.MaxUint256);
  const expiry = (await time.latest()) + 90 * DAY;
  await pbm.connect(corp).createProgram("Community Vouchers", expiry, [merchant.address]);
  await pbm.connect(corp).issue(1, [alice.address, bob.address], [cash(300), cash(300)]);
  return { ...f, id: 1n, expiry };
}

describe("PurposeBoundMoney", () => {
  it("P-01 issuing locks sponsor cash 1:1", async () => {
    const { pbm, token, corp, alice, id } = await loadFixture(pbmFixture);
    expect(await pbm.balanceOf(id, alice.address)).to.equal(cash(300));
    expect(await pbm.totalOutstanding()).to.equal(cash(600));
    expect(await token.balanceOf(await pbm.getAddress())).to.equal(cash(600));
    expect(await token.balanceOf(corp.address)).to.equal(cash(99_400));
  });

  it("P-02 spending at an approved merchant pays the merchant plain cash", async () => {
    const { pbm, token, alice, merchant, id } = await loadFixture(pbmFixture);
    await expect(pbm.connect(alice).spend(id, merchant.address, cash(45.9), ref("receipt-1")))
      .to.changeTokenBalances(token, [merchant], [cash(45.9)]);
    expect(await pbm.balanceOf(id, alice.address)).to.equal(cash(254.1));
  });

  it("P-03 cannot spend at a non-approved merchant or another participant", async () => {
    const { pbm, alice, bob, id } = await loadFixture(pbmFixture);
    await expect(pbm.connect(alice).spend(id, bob.address, cash(1), ref("x"))).to.be.revertedWithCustomError(pbm, "MerchantNotApproved");
  });

  it("P-04 cannot overspend", async () => {
    const { pbm, alice, merchant, id } = await loadFixture(pbmFixture);
    await expect(pbm.connect(alice).spend(id, merchant.address, cash(300.01), ref("x"))).to.be.revertedWithCustomError(pbm, "InsufficientVoucherBalance");
  });

  it("P-05 sponsor can add or remove merchants; others cannot", async () => {
    const { pbm, corp, alice, bob, merchant, id } = await loadFixture(pbmFixture);
    await expect(pbm.connect(alice).setMerchant(id, bob.address, true)).to.be.revertedWithCustomError(pbm, "Unauthorized");
    await pbm.connect(corp).setMerchant(id, merchant.address, false);
    await expect(pbm.connect(alice).spend(id, merchant.address, 1, ref("x"))).to.be.revertedWithCustomError(pbm, "MerchantNotApproved");
  });

  it("P-06 vouchers die at expiry and the sponsor reclaims all unspent value", async () => {
    const { pbm, token, corp, alice, merchant, id, expiry } = await loadFixture(pbmFixture);
    await pbm.connect(alice).spend(id, merchant.address, cash(100), ref("x"));
    await expect(pbm.connect(corp).reclaimExpired(id)).to.be.revertedWithCustomError(pbm, "NotExpired");
    await time.increaseTo(expiry);
    expect(await pbm.spendableBalance(id, alice.address)).to.equal(0);
    await expect(pbm.connect(alice).spend(id, merchant.address, 1, ref("x"))).to.be.revertedWithCustomError(pbm, "Expired");
    await expect(pbm.connect(corp).reclaimExpired(id)).to.changeTokenBalances(token, [corp], [cash(500)]);
    expect(await pbm.totalOutstanding()).to.equal(0);
    await expect(pbm.connect(corp).reclaimExpired(id)).to.be.revertedWithCustomError(pbm, "AlreadyReclaimed");
  });

  it("P-07 a frozen merchant cannot be paid (ledger rules flow through)", async () => {
    const { pbm, token, alice, merchant, id } = await loadFixture(pbmFixture);
    await token.freeze(merchant.address, ref("review"));
    await expect(pbm.connect(alice).spend(id, merchant.address, 1, ref("x"))).to.be.revertedWithCustomError(token, "AccountIsFrozen");
  });
});
