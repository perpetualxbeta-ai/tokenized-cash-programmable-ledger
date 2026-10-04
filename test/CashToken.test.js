const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ledgerFixture, TIER1_LIMIT, Kind, cash, ref } = require("./fixture");

describe("IdentityRegistry", () => {
  it("R-01 registers participants and reports allowance", async () => {
    const { registry, alice, stranger } = await loadFixture(ledgerFixture);
    expect(await registry.isAllowed(alice.address)).to.equal(true);
    expect(await registry.isAllowed(stranger.address)).to.equal(false);
    expect(await registry.kindOf(alice.address)).to.equal(Kind.INDIVIDUAL);
  });

  it("R-02 rejects duplicates, NONE kind and non-registrars", async () => {
    const { registry, alice, stranger } = await loadFixture(ledgerFixture);
    await expect(registry.register(alice.address, Kind.INDIVIDUAL, 1, "dup")).to.be.revertedWithCustomError(registry, "AlreadyRegistered");
    await expect(registry.register(stranger.address, Kind.NONE, 0, "x")).to.be.revertedWithCustomError(registry, "InvalidKind");
    await expect(registry.connect(stranger).register(stranger.address, Kind.INDIVIDUAL, 1, "me"))
      .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
  });

  it("R-03 holding limits apply only to individuals", async () => {
    const { registry, alice, corp } = await loadFixture(ledgerFixture);
    expect(await registry.holdingLimitOf(alice.address)).to.equal(TIER1_LIMIT);
    expect(await registry.holdingLimitOf(corp.address)).to.equal(0);
  });
});

describe("CashToken", () => {
  describe("issuance & reserves", () => {
    it("C-01 has 2 decimals and supply equals minted amounts", async () => {
      const { token } = await loadFixture(ledgerFixture);
      expect(await token.decimals()).to.equal(2);
      expect(await token.totalSupply()).to.equal(cash(1_101_000));
    });

    it("C-02 cannot mint beyond attested reserves", async () => {
      const { token, bank } = await loadFixture(ledgerFixture);
      const headroom = (await token.attestedReserves()) - (await token.totalSupply());
      await expect(token.mint(bank.address, headroom + 1n, ref("x"))).to.be.revertedWithCustomError(token, "InsufficientReserves");
      await expect(token.mint(bank.address, headroom, ref("x"))).to.emit(token, "Issued");
    });

    it("C-03 reserves can never be attested below supply", async () => {
      const { token } = await loadFixture(ledgerFixture);
      await expect(token.attestReserves(cash(1))).to.be.revertedWithCustomError(token, "ReservesBelowSupply");
    });

    it("C-04 only the issuer can mint or attest", async () => {
      const { token, bank } = await loadFixture(ledgerFixture);
      await expect(token.connect(bank).mint(bank.address, 1, ref("x"))).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
      await expect(token.connect(bank).attestReserves(cash(1e9))).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    });

    it("C-05 redeem burns the holder's cash", async () => {
      const { token, bank } = await loadFixture(ledgerFixture);
      await expect(token.connect(bank).redeem(cash(500), ref("redeem-1")))
        .to.emit(token, "Redeemed").withArgs(bank.address, cash(500), ref("redeem-1"));
      expect(await token.balanceOf(bank.address)).to.equal(cash(999_500));
    });

    it("C-06 backing ratio is reserves / supply", async () => {
      const { token } = await loadFixture(ledgerFixture);
      const expected = (cash(10_000_000) * 10_000n) / cash(1_101_000);
      expect(await token.backingRatioBps()).to.equal(expected);
    });
  });

  describe("permissioned transfers", () => {
    it("C-07 pay() moves cash and emits a payment reference", async () => {
      const { token, alice, merchant } = await loadFixture(ledgerFixture);
      await expect(token.connect(alice).pay(merchant.address, cash(12.5), ref("INV-001")))
        .to.emit(token, "Payment").withArgs(alice.address, merchant.address, cash(12.5), ref("INV-001"));
      expect(await token.balanceOf(merchant.address)).to.equal(cash(12.5));
    });

    it("C-08 unregistered addresses can neither receive nor be minted to", async () => {
      const { token, alice, stranger } = await loadFixture(ledgerFixture);
      await expect(token.connect(alice).transfer(stranger.address, 1)).to.be.revertedWithCustomError(token, "NotAllowed").withArgs(stranger.address);
      await expect(token.mint(stranger.address, 1, ref("x"))).to.be.revertedWithCustomError(token, "NotAllowed");
    });

    it("C-09 deactivated participants cannot send", async () => {
      const { token, registry, alice, bob } = await loadFixture(ledgerFixture);
      await registry.update(alice.address, Kind.INDIVIDUAL, 1, false);
      await expect(token.connect(alice).transfer(bob.address, 1)).to.be.revertedWithCustomError(token, "NotAllowed").withArgs(alice.address);
    });

    it("C-10 individual holding limit is enforced on receipt", async () => {
      const { token, bank, bob } = await loadFixture(ledgerFixture);
      await token.connect(bank).transfer(bob.address, TIER1_LIMIT);
      await expect(token.connect(bank).transfer(bob.address, 1)).to.be.revertedWithCustomError(token, "HoldingLimitExceeded");
    });
  });

  describe("compliance controls", () => {
    it("C-11 frozen accounts cannot send, receive or redeem", async () => {
      const { token, alice, bob, bank } = await loadFixture(ledgerFixture);
      await token.freeze(alice.address, ref("AML-review"));
      await expect(token.connect(alice).transfer(bob.address, 1)).to.be.revertedWithCustomError(token, "AccountIsFrozen");
      await expect(token.connect(bank).transfer(alice.address, 1)).to.be.revertedWithCustomError(token, "AccountIsFrozen");
      await expect(token.connect(alice).redeem(1, ref("x"))).to.be.revertedWithCustomError(token, "AccountIsFrozen");
      await token.unfreeze(alice.address);
      await expect(token.connect(alice).transfer(bob.address, 1)).to.not.be.reverted;
    });

    it("C-12 compliance can force-transfer out of a frozen account", async () => {
      const { token, alice, issuer } = await loadFixture(ledgerFixture);
      await token.freeze(alice.address, ref("court-order"));
      await expect(token.forceTransfer(alice.address, issuer.address, cash(1_000), ref("court-order")))
        .to.emit(token, "ForcedTransfer");
      expect(await token.balanceOf(alice.address)).to.equal(0);
    });

    it("C-13 pause halts every movement including minting", async () => {
      const { token, alice, bob, bank } = await loadFixture(ledgerFixture);
      await token.pause();
      await expect(token.connect(alice).transfer(bob.address, 1)).to.be.revertedWithCustomError(token, "EnforcedPause");
      await expect(token.mint(bank.address, 1, ref("x"))).to.be.revertedWithCustomError(token, "EnforcedPause");
      await token.unpause();
      await expect(token.connect(alice).transfer(bob.address, 1)).to.not.be.reverted;
    });

    it("C-14 only compliance/pauser roles can use controls", async () => {
      const { token, alice, bob } = await loadFixture(ledgerFixture);
      await expect(token.connect(bob).freeze(alice.address, ref("x"))).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
      await expect(token.connect(bob).forceTransfer(alice.address, bob.address, 1, ref("x"))).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
      await expect(token.connect(bob).pause()).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    });
  });
});
