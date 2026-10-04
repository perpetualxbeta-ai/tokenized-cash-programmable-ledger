// Randomized stateful test: fire a long, seeded sequence of random operations from random
// participants (many of which are expected to revert) and check the ledger invariants after
// every single step. Reproduce a failure with INVARIANT_SEED=<seed> npx hardhat test.
const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ethers } = require("hardhat");
const { ledgerFixture, cash, ref } = require("./fixture");

const STEPS = Number(process.env.INVARIANT_STEPS || 250);
const SEED = Number(process.env.INVARIANT_SEED || 20261004);

function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("Ledger invariants (randomized)", () => {
  it(`INV-01 hold across ${STEPS} random operations (seed ${SEED})`, async () => {
    const f = await loadFixture(ledgerFixture);
    const { token, escrow, pbm, dvp, bond, registry, issuer, bank, corp, alice, bob, merchant, arbiter, stranger } = f;
    const rand = prng(SEED);
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];
    const amt = (max) => BigInt(1 + Math.floor(rand() * max)) * 100n; // whole units

    const users = [bank, corp, alice, bob, merchant, arbiter, stranger];
    const contracts = [escrow, pbm, dvp];
    const addrs = await Promise.all(contracts.map((c) => c.getAddress()));
    for (const u of users) {
      for (const a of addrs) await token.connect(u).approve(a, ethers.MaxUint256);
      await bond.connect(u).approve(addrs[2], ethers.MaxUint256);
    }
    await bond.mint(bank.address, 1_000);

    const holders = [issuer, ...users].map((u) => u.address).concat(addrs);
    const counts = { ok: 0, reverted: 0 };

    const ops = [
      async () => token.connect(pick(users)).pay(pick(users).address, amt(2_000), ref("p")),
      async () => token.mint(pick(users).address, amt(5_000), ref("m")),
      async () => token.connect(pick(users)).redeem(amt(1_000), ref("r")),
      async () => {
        const deadline = (await time.latest()) + 1 + Math.floor(rand() * 5 * 86400);
        const n = 1 + Math.floor(rand() * 3);
        const amounts = Array.from({ length: n }, () => amt(500));
        return escrow.connect(pick(users)).create(pick(users).address, pick([ethers.ZeroAddress, arbiter.address]), deadline, amounts, ref("e"));
      },
      async () => escrow.connect(pick(users)).release(1 + Math.floor(rand() * Number((await escrow.escrowCount()) + 1n)), Math.floor(rand() * 3)),
      async () => escrow.connect(pick(users)).refund(1 + Math.floor(rand() * Number((await escrow.escrowCount()) + 1n)), Math.floor(rand() * 3)),
      async () => escrow.connect(pick(users)).reclaimAfterDeadline(1 + Math.floor(rand() * Number((await escrow.escrowCount()) + 1n))),
      async () => escrow.connect(pick(users)).withdraw(),
      async () => pbm.connect(pick(users)).createProgram("prog", (await time.latest()) + 1 + Math.floor(rand() * 5 * 86400), [merchant.address]),
      async () => pbm.connect(pick(users)).issue(1 + Math.floor(rand() * Number(await pbm.programCount())), [alice.address, bob.address], [amt(200), amt(200)]),
      async () => pbm.connect(pick(users)).spend(1 + Math.floor(rand() * Number(await pbm.programCount())), pick([merchant, bob]).address, amt(150), ref("s")),
      async () => pbm.connect(pick(users)).reclaimExpired(1 + Math.floor(rand() * Number(await pbm.programCount()))),
      async () => {
        const deadline = (await time.latest()) + 1 + Math.floor(rand() * 86400);
        return dvp.connect(bank).propose(bank.address, pick(users).address, await bond.getAddress(), 1 + Math.floor(rand() * 20), amt(3_000), deadline, ref("t"));
      },
      async () => dvp.connect(pick(users)).settle(1 + Math.floor(rand() * Number((await dvp.tradeCount()) + 1n))),
      async () => token.freeze(pick(users).address, ref("f")),
      async () => token.unfreeze(pick(users).address),
      async () => time.increase(Math.floor(rand() * 2 * 86400)),
    ];

    for (let step = 0; step < STEPS; step++) {
      // snapshot frozen balances: they must never decrease (no force transfers in this run)
      const frozenBefore = {};
      for (const h of holders) if (await token.frozen(h)) frozenBefore[h] = await token.balanceOf(h);

      try {
        const tx = await pick(ops)();
        if (tx && tx.wait) await tx.wait();
        counts.ok++;
      } catch {
        counts.reverted++;
      }

      const supply = await token.totalSupply();
      let sum = 0n;
      for (const h of holders) sum += await token.balanceOf(h);
      const ctx = `step ${step} (seed ${SEED})`;

      expect(sum, `${ctx}: sum(balances) == totalSupply`).to.equal(supply);
      expect(supply <= (await token.attestedReserves()), `${ctx}: supply <= reserves`).to.equal(true);
      expect(await token.balanceOf(addrs[0]), `${ctx}: escrow fully backed`).to.equal((await escrow.totalLocked()) + (await escrow.totalClaimable()));
      expect(await token.balanceOf(addrs[1]), `${ctx}: PBM fully backed`).to.equal(await pbm.totalOutstanding());
      expect(await token.balanceOf(addrs[2]), `${ctx}: DvP never custodies`).to.equal(0);
      for (const u of [alice, bob]) {
        const limit = await registry.holdingLimitOf(u.address);
        expect((await token.balanceOf(u.address)) <= limit, `${ctx}: holding limit`).to.equal(true);
      }
      for (const [h, bal] of Object.entries(frozenBefore)) {
        expect((await token.balanceOf(h)) >= bal, `${ctx}: frozen balance never drops`).to.equal(true);
      }
    }

    // Make sure the run actually exercised the system rather than reverting everything.
    expect(counts.ok).to.be.greaterThan(STEPS / 5);
    expect(await escrow.escrowCount()).to.be.greaterThan(0n);
  });
});
