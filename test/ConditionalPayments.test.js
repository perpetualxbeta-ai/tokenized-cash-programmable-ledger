const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");
const { ledgerFixture, cash, ref } = require("./fixture");

const PENDING = 0, RELEASED = 1, REFUNDED = 2;
const DAY = 24 * 60 * 60;

async function escrowFixture() {
  const f = await ledgerFixture();
  const { token, escrow, corp, alice, arbiter } = f;
  await token.connect(corp).approve(await escrow.getAddress(), ethers.MaxUint256);
  const deadline = (await time.latest()) + 30 * DAY;
  const amounts = [cash(1_000), cash(2_000), cash(500)];
  await escrow.connect(corp).create(alice.address, arbiter.address, deadline, amounts, ref("PO-77"));
  return { ...f, id: 1n, deadline, amounts };
}

describe("ConditionalPayments", () => {
  describe("create", () => {
    it("E-01 locks the total and records milestones", async () => {
      const { escrow, token, corp, alice, id } = await loadFixture(escrowFixture);
      const [e, amounts, states] = await escrow.getEscrow(id);
      expect(e.payer).to.equal(corp.address);
      expect(e.payee).to.equal(alice.address);
      expect(e.total).to.equal(cash(3_500));
      expect(amounts.length).to.equal(3);
      expect(states.every((s) => s === BigInt(PENDING))).to.equal(true);
      expect(await token.balanceOf(await escrow.getAddress())).to.equal(cash(3_500));
      expect(await escrow.totalLocked()).to.equal(cash(3_500));
    });

    it("E-02 rejects bad parameters", async () => {
      const { escrow, corp, alice, arbiter } = await loadFixture(escrowFixture);
      const d = (await time.latest()) + DAY;
      const c = escrow.connect(corp);
      await expect(c.create(corp.address, ethers.ZeroAddress, d, [1], ref("x"))).to.be.revertedWithCustomError(escrow, "InvalidParty");
      await expect(c.create(alice.address, alice.address, d, [1], ref("x"))).to.be.revertedWithCustomError(escrow, "InvalidParty");
      await expect(c.create(alice.address, arbiter.address, 1, [1], ref("x"))).to.be.revertedWithCustomError(escrow, "DeadlineInPast");
      await expect(c.create(alice.address, arbiter.address, d, [], ref("x"))).to.be.revertedWithCustomError(escrow, "NoMilestones");
      await expect(c.create(alice.address, arbiter.address, d, [1, 0], ref("x"))).to.be.revertedWithCustomError(escrow, "ZeroAmount");
    });

    it("E-03 escrow can only be funded by registered payers (ledger rules apply)", async () => {
      const { escrow, alice, stranger } = await loadFixture(escrowFixture);
      const d = (await time.latest()) + DAY;
      await expect(escrow.connect(stranger).create(alice.address, ethers.ZeroAddress, d, [1], ref("x"))).to.be.reverted;
    });
  });

  describe("release / refund", () => {
    it("E-04 payer releases a milestone; payee withdraws (pull payment)", async () => {
      const { escrow, token, corp, alice, id } = await loadFixture(escrowFixture);
      await expect(escrow.connect(corp).release(id, 0)).to.emit(escrow, "MilestoneReleased").withArgs(id, 0, corp.address, cash(1_000));
      expect(await escrow.claimable(alice.address)).to.equal(cash(1_000));
      await expect(escrow.connect(alice).withdraw()).to.changeTokenBalances(token, [alice], [cash(1_000)]);
      await expect(escrow.connect(alice).withdraw()).to.be.revertedWithCustomError(escrow, "NothingToWithdraw");
    });

    it("E-05 a milestone settles exactly once", async () => {
      const { escrow, corp, alice, id } = await loadFixture(escrowFixture);
      await escrow.connect(corp).release(id, 1);
      await expect(escrow.connect(corp).release(id, 1)).to.be.revertedWithCustomError(escrow, "NotPending");
      await expect(escrow.connect(alice).refund(id, 1)).to.be.revertedWithCustomError(escrow, "NotPending");
      await expect(escrow.connect(corp).release(id, 9)).to.be.revertedWithCustomError(escrow, "InvalidMilestone");
    });

    it("E-06 payee may voluntarily refund; strangers can do nothing", async () => {
      const { escrow, corp, alice, stranger, id } = await loadFixture(escrowFixture);
      await escrow.connect(alice).refund(id, 2);
      expect(await escrow.claimable(corp.address)).to.equal(cash(500));
      await expect(escrow.connect(stranger).release(id, 0)).to.be.revertedWithCustomError(escrow, "Unauthorized");
      await expect(escrow.connect(stranger).refund(id, 0)).to.be.revertedWithCustomError(escrow, "Unauthorized");
      await expect(escrow.connect(alice).release(id, 0)).to.be.revertedWithCustomError(escrow, "Unauthorized");
      await expect(escrow.connect(corp).refund(id, 0)).to.be.revertedWithCustomError(escrow, "Unauthorized");
    });

    it("E-07 a frozen payee cannot block settlement; funds wait in claimable", async () => {
      const { escrow, token, corp, alice, id } = await loadFixture(escrowFixture);
      await token.freeze(alice.address, ref("review"));
      await escrow.connect(corp).release(id, 0); // settles fine
      await expect(escrow.connect(alice).withdraw()).to.be.revertedWithCustomError(token, "AccountIsFrozen");
      await token.unfreeze(alice.address);
      await escrow.connect(alice).withdraw();
    });
  });

  describe("disputes & deadline", () => {
    it("E-08 dispute blocks the payer; only the arbiter can settle", async () => {
      const { escrow, corp, alice, arbiter, id } = await loadFixture(escrowFixture);
      await escrow.connect(alice).dispute(id);
      await expect(escrow.connect(corp).release(id, 0)).to.be.revertedWithCustomError(escrow, "EscrowDisputed");
      await escrow.connect(arbiter).release(id, 0);
      await escrow.connect(arbiter).refund(id, 1);
      expect(await escrow.claimable(alice.address)).to.equal(cash(1_000));
      expect(await escrow.claimable(corp.address)).to.equal(cash(2_000));
    });

    it("E-09 dispute requires an arbiter", async () => {
      const { escrow, corp, alice } = await loadFixture(escrowFixture);
      const d = (await time.latest()) + DAY;
      await escrow.connect(corp).create(alice.address, ethers.ZeroAddress, d, [cash(1)], ref("x"));
      await expect(escrow.connect(alice).dispute(2)).to.be.revertedWithCustomError(escrow, "NoArbiter");
    });

    it("E-10 payer reclaims pending milestones only after the deadline", async () => {
      const { escrow, corp, id, deadline } = await loadFixture(escrowFixture);
      await escrow.connect(corp).release(id, 0);
      await expect(escrow.connect(corp).reclaimAfterDeadline(id)).to.be.revertedWithCustomError(escrow, "DeadlineNotReached");
      await time.increaseTo(deadline);
      await expect(escrow.connect(corp).reclaimAfterDeadline(id)).to.emit(escrow, "Reclaimed").withArgs(id, cash(2_500));
      const [, , states] = await escrow.getEscrow(id);
      expect(states.map(Number)).to.deep.equal([RELEASED, REFUNDED, REFUNDED]);
      expect(await escrow.totalLocked()).to.equal(0);
      await expect(escrow.connect(corp).reclaimAfterDeadline(id)).to.be.revertedWithCustomError(escrow, "NotPending");
    });

    it("E-11 a disputed escrow cannot be reclaimed at the deadline", async () => {
      const { escrow, corp, id, deadline } = await loadFixture(escrowFixture);
      await escrow.connect(corp).dispute(id);
      await time.increaseTo(deadline);
      await expect(escrow.connect(corp).reclaimAfterDeadline(id)).to.be.revertedWithCustomError(escrow, "EscrowDisputed");
    });
  });
});
