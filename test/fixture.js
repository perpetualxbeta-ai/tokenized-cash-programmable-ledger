const { ethers } = require("hardhat");
const { deployLedger, Kind, cash, ref } = require("../scripts/lib/deploy");

const TIER1_LIMIT = cash(5_000); // individuals in tier 1 may hold at most 5,000.00

/** Full ledger with a small cast of participants, funded and ready. */
async function ledgerFixture() {
  const [issuer, bank, corp, alice, bob, merchant, arbiter, stranger] = await ethers.getSigners();
  const c = await deployLedger(issuer);
  const { registry, token } = c;

  await registry.register(bank.address, Kind.BANK, 0, "Bank A");
  await registry.register(corp.address, Kind.CORPORATE, 0, "Acme Pte Ltd");
  await registry.register(alice.address, Kind.INDIVIDUAL, 1, "Alice");
  await registry.register(bob.address, Kind.INDIVIDUAL, 1, "Bob");
  await registry.register(merchant.address, Kind.MERCHANT, 0, "Corner Grocer");
  await registry.register(arbiter.address, Kind.CORPORATE, 0, "Arbitration Co");
  await registry.setTierHoldingLimit(1, TIER1_LIMIT);

  await token.attestReserves(cash(10_000_000));
  await token.mint(bank.address, cash(1_000_000), ref("seed-bank"));
  await token.mint(corp.address, cash(100_000), ref("seed-corp"));
  await token.mint(alice.address, cash(1_000), ref("seed-alice"));

  return { ...c, issuer, bank, corp, alice, bob, merchant, arbiter, stranger };
}

module.exports = { ledgerFixture, TIER1_LIMIT, Kind, cash, ref };
