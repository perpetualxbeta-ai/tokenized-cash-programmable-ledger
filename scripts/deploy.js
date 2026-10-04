// Deploy the full ledger stack and write the addresses to deployments/<network>.json.
//
//   npx hardhat node                                     # terminal 1: local chain
//   npx hardhat run scripts/deploy.js --network localhost # terminal 2
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { deployLedger } = require("./lib/deploy");

async function main() {
  const [admin] = await hre.ethers.getSigners();
  const c = await deployLedger(admin);
  const out = { network: hre.network.name, chainId: Number((await hre.ethers.provider.getNetwork()).chainId), admin: admin.address };
  for (const [k, v] of Object.entries(c)) out[k] = await v.getAddress();

  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${hre.network.name}.json`), JSON.stringify(out, null, 2));
  console.table(out);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
