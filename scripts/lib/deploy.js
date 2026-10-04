// Shared deployment of the whole ledger stack. Used by tests, the simulator and the deploy script.
const { ethers } = require("hardhat");

const Kind = { NONE: 0, ISSUER: 1, BANK: 2, CORPORATE: 3, INDIVIDUAL: 4, MERCHANT: 5, SYSTEM: 6 };

/** Convert a decimal amount (e.g. "12.50") to cash units (2 decimals). */
const cash = (v) => ethers.parseUnits(String(v), 2);
/** Short string -> bytes32 reference. */
const ref = (s) => ethers.encodeBytes32String(s);

async function deployLedger(admin, { name = "Tokenized SGD", symbol = "tSGD" } = {}) {
  const registry = await ethers.deployContract("IdentityRegistry", [admin.address], admin);
  const token = await ethers.deployContract("CashToken", [name, symbol, await registry.getAddress(), admin.address], admin);
  const tokenAddr = await token.getAddress();
  const escrow = await ethers.deployContract("ConditionalPayments", [tokenAddr], admin);
  const pbm = await ethers.deployContract("PurposeBoundMoney", [tokenAddr], admin);
  const dvp = await ethers.deployContract("DvPSettlement", [tokenAddr], admin);
  const bond = await ethers.deployContract("AssetToken", ["Tokenized Govt Bond 2030", "BOND30", await registry.getAddress(), admin.address], admin);

  // Issuer + system contracts are participants on the ledger too.
  await registry.register(admin.address, Kind.ISSUER, 0, "Issuer");
  await registry.register(await escrow.getAddress(), Kind.SYSTEM, 0, "ConditionalPayments");
  await registry.register(await pbm.getAddress(), Kind.SYSTEM, 0, "PurposeBoundMoney");
  await registry.register(await dvp.getAddress(), Kind.SYSTEM, 0, "DvPSettlement");

  return { registry, token, escrow, pbm, dvp, bond };
}

module.exports = { deployLedger, Kind, cash, ref };
