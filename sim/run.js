// Tokenized cash ledger simulation.
//
//   npx hardhat run sim/run.js          (or: npm run sim)
//   SIM_SEED=7 SIM_DAYS=21 npm run sim  (different, but reproducible, run)
//
// Spins up an economy of an issuer, banks, corporates, a government agency, merchants and
// individuals on a local chain, then plays out a schedule of scenarios day by day:
// issuance, payroll, retail payments, multi-milestone escrows with a dispute, a purpose-bound
// voucher programme, DvP bond trades, a compliance incident, a ledger pause and a redemption
// wave. Every attempted action is recorded (including the ones the ledger rules reject), the
// chain is indexed into a journal, invariants are reconciled, and a report is written to sim/out/.

const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const path = require("path");
const { deployLedger, Kind, cash, ref } = require("../scripts/lib/deploy");
const { prng } = require("../scripts/lib/prng");
const { indexLedger, CATEGORIES } = require("./indexer");
const { renderReport } = require("./report");

const SEED = Number(process.env.SIM_SEED || 42);
const DAYS = Math.max(12, Number(process.env.SIM_DAYS || 14));
const OUT = path.join(__dirname, "out");
const DAY = 86400;

const fmt = (v) => Number(ethers.formatUnits(v, 2)).toLocaleString("en-SG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main() {
  if (hre.network.name !== "hardhat") {
    console.warn(`Warning: running against "${hre.network.name}". The simulation uses time travel and is meant for the in-process hardhat network.`);
  }
  const r = prng(SEED);
  const signers = await ethers.getSigners();
  if (signers.length < 47) throw new Error("Need at least 47 accounts (see hardhat.config.cjs networks.hardhat.accounts.count)");

  // ---------------------------------------------------------------------------------------
  // Cast
  // ---------------------------------------------------------------------------------------
  const issuer = signers[0];
  const banks = signers.slice(1, 4);
  const corps = signers.slice(4, 9);
  const agency = signers[9];
  const arbiter = signers[10];
  const merchants = signers.slice(11, 17);
  const people = signers.slice(17, 47);

  const BANK_NAMES = ["Lion City Bank", "Straits Commercial", "Marina Digital Bank"];
  const CORP_NAMES = ["Acme Logistics", "Orchid Foods", "Harbour Tech", "Kallang Builders", "Merlion Media"];
  const MERCHANT_NAMES = ["Hawker Centre #12", "FairMart Grocer", "Kopi Corner", "Neighbourhood Pharmacy", "LuxeWatch Boutique", "Night Club 88"];

  const c = await deployLedger(issuer);
  const { registry, token, escrow, pbm, dvp, bond } = c;
  const iface = [token, escrow, pbm, dvp, bond, registry].map((x) => x.interface);

  const names = {};
  const kinds = {};
  const tag = (s, name, kind) => {
    names[s.address.toLowerCase()] = name;
    kinds[s.address.toLowerCase()] = kind;
  };
  tag(issuer, "Issuer (central bank)", "ISSUER");
  names[(await escrow.getAddress()).toLowerCase()] = "ConditionalPayments";
  names[(await pbm.getAddress()).toLowerCase()] = "PurposeBoundMoney";
  names[(await dvp.getAddress()).toLowerCase()] = "DvPSettlement";
  for (const k of ["escrow", "pbm", "dvp"]) kinds[(await c[k].getAddress()).toLowerCase()] = "SYSTEM";

  for (let i = 0; i < banks.length; i++) {
    await registry.register(banks[i].address, Kind.BANK, 0, BANK_NAMES[i]);
    tag(banks[i], BANK_NAMES[i], "BANK");
  }
  for (let i = 0; i < corps.length; i++) {
    await registry.register(corps[i].address, Kind.CORPORATE, 0, CORP_NAMES[i]);
    tag(corps[i], CORP_NAMES[i], "CORPORATE");
  }
  await registry.register(agency.address, Kind.CORPORATE, 0, "Community Development Agency");
  tag(agency, "Community Development Agency", "CORPORATE");
  await registry.register(arbiter.address, Kind.CORPORATE, 0, "Trade Arbitration Centre");
  tag(arbiter, "Trade Arbitration Centre", "CORPORATE");
  for (let i = 0; i < merchants.length; i++) {
    await registry.register(merchants[i].address, Kind.MERCHANT, 0, MERCHANT_NAMES[i]);
    tag(merchants[i], MERCHANT_NAMES[i], "MERCHANT");
  }
  await registry.setTierHoldingLimit(1, cash(5_000));
  await registry.setTierHoldingLimit(2, cash(20_000));
  const employer = new Map();
  for (let i = 0; i < people.length; i++) {
    const tier = r.chance(0.6) ? 1 : 2;
    await registry.register(people[i].address, Kind.INDIVIDUAL, tier, `Person ${String(i + 1).padStart(2, "0")}`);
    tag(people[i], `Person ${String(i + 1).padStart(2, "0")} (T${tier})`, "INDIVIDUAL");
    employer.set(people[i], corps[i % corps.length]);
  }

  // ---------------------------------------------------------------------------------------
  // Action recorder: every attempt is logged, rejections are decoded to the custom error name
  // ---------------------------------------------------------------------------------------
  let day = 0;
  const attempts = { ok: 0, rejected: 0 };
  const rejections = {}; // reason -> count
  const events = []; // narrative log for the report

  const reason = (e) => {
    const data = e?.data || e?.info?.error?.data || e?.error?.data;
    if (typeof data === "string" && data.length >= 10) {
      for (const i of iface) {
        try {
          const p = i.parseError(data);
          if (p) return p.name;
        } catch {}
      }
    }
    return e?.revert?.name || e?.shortMessage || "Reverted";
  };

  async function act(fn) {
    try {
      const tx = await fn();
      const rc = await tx.wait();
      attempts.ok++;
      return rc;
    } catch (e) {
      attempts.rejected++;
      const why = reason(e);
      rejections[why] = (rejections[why] || 0) + 1;
      return null;
    }
  }
  const note = (scenario, text) => events.push({ day, scenario, text });

  const timeline = [];
  async function snapshot() {
    timeline.push({
      day,
      supply: await token.totalSupply(),
      reserves: await token.attestedReserves(),
      escrowLocked: await escrow.totalLocked(),
      escrowClaimable: await escrow.totalClaimable(),
      pbmOutstanding: await pbm.totalOutstanding(),
    });
  }
  async function nextDay() {
    await snapshot();
    await ethers.provider.send("evm_increaseTime", [DAY]);
    await ethers.provider.send("evm_mine", []);
    day++;
  }
  const now = async () => (await ethers.provider.getBlock("latest")).timestamp;
  const approveAll = async (s) => {
    for (const a of [escrow, pbm, dvp]) await token.connect(s).approve(await a.getAddress(), ethers.MaxUint256);
  };

  // ---------------------------------------------------------------------------------------
  // Day 0: issuance & funding
  // ---------------------------------------------------------------------------------------
  // Banks deposit fiat with the issuer; the issuer attests the reserves, then issues 1:1.
  await token.attestReserves(cash(15_000_000));
  for (const b of banks) await act(async () => token.mint(b.address, cash(5_000_000), ref("RESERVE-TOPUP")));
  const overIssue = await act(async () => token.mint(banks[0].address, cash(1), ref("OVER-ISSUE")));
  note("Issuance", `Banks deposited ${fmt(cash(15_000_000))} of fiat reserves; the issuer attested them and issued the same amount of cash 1:1 (backing 100%). An attempt to issue 0.01 more ${overIssue ? "succeeded (!)" : "was rejected: supply can never exceed reserves"}.`);
  for (const co of corps) await act(async () => token.connect(r.pick(banks)).pay(co.address, cash(r.int(400_000, 800_000)), ref("CORP-ACCOUNT-FUNDING")));
  await act(async () => token.connect(banks[0]).pay(agency.address, cash(1_000_000), ref("BUDGET-FY26")));
  for (const s of [...corps, agency, ...banks]) await approveAll(s);
  await bond.mint(banks[0].address, 500);
  await bond.mint(banks[1].address, 300);
  for (const b of banks) await bond.connect(b).approve(await dvp.getAddress(), ethers.MaxUint256);
  note("Issuance", "Banks funded corporate accounts and the agency budget; 800 bond units issued to two banks.");

  // Payroll
  let payrollOk = 0;
  for (const p of people) {
    const rc = await act(async () => token.connect(employer.get(p)).pay(p.address, cash(r.int(2_800, 5_600)), ref("PAYROLL-M1")));
    if (rc) payrollOk++;
  }
  note("Payroll", `${payrollOk}/${people.length} salaries paid. Payments that would push a tier-1 individual over the 5,000.00 holding limit are rejected by the ledger.`);
  await nextDay();

  // ---------------------------------------------------------------------------------------
  // Day-by-day schedule
  // ---------------------------------------------------------------------------------------
  const deals = [];
  let programId = 0n;
  let pbmExpiryDay = 0;
  const frozenPerson = people[3];
  const seizedPerson = people[7];

  for (; day <= DAYS; ) {
    // --- retail economy, every day ---
    const nPay = r.int(20, 40);
    for (let i = 0; i < nPay; i++) {
      const p = r.pick(people);
      const retail = r.chance(0.8);
      const amount = retail ? cash(r.int(5, 250)) : cash(r.int(10, 400));
      if ((await token.balanceOf(p.address)) < amount) continue; // wallets don't attempt overdrafts
      const to = retail ? r.pick(merchants) : r.pick(people);
      await act(async () => token.connect(p).pay(to.address, amount, ref(retail ? `POS-D${day}-${i}` : `P2P-D${day}`)));
    }
    // merchants sweep takings to their bank at end of day
    for (const m of merchants) {
      const bal = await token.balanceOf(m.address);
      if (bal > cash(1_000) && r.chance(0.5)) await act(async () => token.connect(m).pay(banks[0].address, bal / 2n, ref(`SWEEP-D${day}`)));
    }

    // --- Day 1: B2B escrows ---
    if (day === 1) {
      for (let i = 0; i < 8; i++) {
        const payer = corps[i % corps.length];
        const payee = corps[(i + 1 + r.int(0, 3)) % corps.length];
        const n = r.int(2, 4);
        const amounts = Array.from({ length: n }, () => cash(r.int(5_000, 40_000)));
        const deadline = (await now()) + r.int(5, 9) * DAY;
        const withArbiter = i < 4;
        const rc = await act(async () => escrow.connect(payer).create(payee.address, withArbiter ? arbiter.address : ethers.ZeroAddress, deadline, amounts, ref(`PO-${1000 + i}`)));
        if (rc) deals.push({ id: await escrow.escrowCount(), payer, payee, n, withArbiter, deadline });
      }
      note("Conditional payments", `${deals.length} multi-milestone B2B escrows opened between corporates (4 with an arbiter).`);
    }

    // --- Day 2: purpose-bound voucher programme ---
    if (day === 2) {
      const approved = merchants.slice(0, 4).map((m) => m.address); // excludes luxury & nightlife
      pbmExpiryDay = day + 7;
      await act(async () => pbm.connect(agency).createProgram("Community Vouchers 2026", (await now()) + 7 * DAY, approved));
      programId = await pbm.programCount();
      await act(async () => pbm.connect(agency).issue(programId, people.map((p) => p.address), people.map(() => cash(200))));
      note("Purpose-bound money", `Agency issued 200.00 of vouchers to each of ${people.length} residents (expires day ${pbmExpiryDay}), spendable only at 4 approved everyday merchants.`);
    }
    if (programId > 0n && day > 2 && day < pbmExpiryDay) {
      let spentOk = 0, blocked = 0;
      for (const p of people) {
        if (!r.chance(0.45)) continue;
        const m = r.chance(0.85) ? merchants[r.int(0, 3)] : merchants[r.int(4, 5)];
        const rc = await act(async () => pbm.connect(p).spend(programId, m.address, cash(r.int(10, 80)), ref(`PBM-D${day}`)));
        rc ? spentOk++ : blocked++;
      }
      note("Purpose-bound money", `${spentOk} voucher purchases settled to merchants as cash; ${blocked} attempt${blocked === 1 ? "" : "s"} blocked (non-approved merchant or insufficient vouchers).`);
    }
    if (programId > 0n && day === pbmExpiryDay) {
      const before = await pbm.totalOutstanding();
      await act(async () => pbm.connect(agency).reclaimExpired(programId));
      note("Purpose-bound money", `Programme expired; ${fmt(before)} of unspent vouchers returned to the agency in one call.`);
    }

    // --- escrow progress ---
    if (day >= 2 && day <= 8) {
      for (const d of deals) {
        if (d.id === 2n) continue; // the disputed deal
        if (r.chance(0.35)) {
          const [, , states] = await escrow.getEscrow(d.id);
          const idx = states.findIndex((s) => s === 0n);
          if (idx >= 0) await act(async () => escrow.connect(d.payer).release(d.id, idx));
        }
      }
    }
    if (day === 3 && deals.length > 1) {
      await act(async () => escrow.connect(deals[1].payee).dispute(deals[1].id));
      note("Conditional payments", `Escrow #2 disputed by the supplier; the buyer can no longer release or reclaim unilaterally.`);
    }
    if (day === 5 && deals.length > 1) {
      await act(async () => escrow.connect(deals[1].payer).release(deals[1].id, 0)); // rejected: disputed
      await act(async () => escrow.connect(arbiter).release(deals[1].id, 0));
      for (let i = 1; i < deals[1].n; i++) await act(async () => escrow.connect(arbiter).refund(deals[1].id, i));
      note("Conditional payments", `Arbiter resolved disputed escrow #2: milestone 1 paid to the supplier, the remaining ${deals[1].n - 1} refunded to the buyer.`);
    }

    // --- Day 4: DvP bond trades ---
    if (day === 4) {
      let ok = 0;
      for (let i = 0; i < 5; i++) {
        const seller = banks[i % 2];
        const buyer = corps[i];
        const units = r.int(5, 40);
        const price = cash(units * r.int(1_000, 1_030));
        const rc = await act(async () => dvp.connect(seller).propose(seller.address, buyer.address, bond.getAddress(), units, price, BigInt((await now()) + DAY), ref(`BOND-T${i + 1}`)));
        if (!rc) continue;
        const id = await dvp.tradeCount();
        if (i === 4) {
          // the buyer is frozen just before settlement: both legs must fail together
          await act(async () => token.freeze(buyer.address, ref("SANCTIONS-SCREEN")));
          await act(async () => dvp.connect(buyer).settle(id));
          await act(async () => token.unfreeze(buyer.address));
          note("DvP settlement", `Trade BOND-T5 failed atomically when the buyer was frozen mid-flow: no bonds moved, no cash moved.`);
        } else if (await act(async () => dvp.connect(buyer).settle(id))) ok++;
      }
      note("DvP settlement", `${ok} bond trades settled delivery-versus-payment in a single transaction each.`);
    }

    // --- Day 6-8: compliance incident ---
    if (day === 6) {
      await act(async () => token.freeze(frozenPerson.address, ref("AML-ALERT-4471")));
      await act(async () => token.freeze(seizedPerson.address, ref("COURT-ORDER-88")));
      for (let i = 0; i < 3; i++) await act(async () => token.connect(frozenPerson).pay(merchants[0].address, cash(20), ref("blocked")));
      await act(async () => token.connect(banks[0]).pay(frozenPerson.address, cash(50), ref("blocked-in")));
      note("Compliance", `Two individuals frozen (AML alert, court order). Their outgoing and incoming payments are now rejected.`);
    }
    if (day === 8) {
      await act(async () => token.unfreeze(frozenPerson.address));
      const bal = await token.balanceOf(seizedPerson.address);
      await act(async () => token.forceTransfer(seizedPerson.address, issuer.address, bal / 2n, ref("COURT-ORDER-88")));
      note("Compliance", `AML alert cleared and account unfrozen. Court order executed: ${fmt(bal / 2n)} force-transferred out of the frozen account.`);
    }

    // --- Day 10: operational incident, ledger paused ---
    if (day === 10) {
      await act(async () => token.pause());
      let blocked = 0;
      for (let i = 0; i < 10; i++) if (!(await act(async () => token.connect(r.pick(people)).pay(r.pick(merchants).address, cash(15), ref("during-pause"))))) blocked++;
      await act(async () => token.unpause());
      note("Operations", `Ledger paused for an incident; ${blocked} payments rejected while paused, then service resumed.`);
    }

    // --- Day 11: escrow deadlines: payers reclaim, everyone withdraws ---
    if (day === 11) {
      let reclaimed = 0n;
      for (const d of deals) {
        const before = await escrow.claimable(d.payer.address);
        if (await act(async () => escrow.connect(d.payer).reclaimAfterDeadline(d.id))) reclaimed += (await escrow.claimable(d.payer.address)) - before;
      }
      for (const s of [...corps]) if ((await escrow.claimable(s.address)) > 0n) await act(async () => escrow.connect(s).withdraw());
      note("Conditional payments", `Deadlines passed: ${fmt(reclaimed)} of undelivered milestones reclaimed by buyers. All settled balances withdrawn.`);
    }

    // --- Day 12: redemption wave (stress) ---
    if (day === 12) {
      let redeemed = 0n;
      const runners = r.sample(people, Math.floor(people.length * 0.3));
      for (const p of runners) {
        const bal = await token.balanceOf(p.address);
        const amt = (bal * BigInt(r.int(50, 90))) / 100n;
        if (amt > 0n && (await act(async () => token.connect(p).redeem(amt, ref("CASH-OUT"))))) redeemed += amt;
      }
      const corpAmt = cash(250_000);
      if (await act(async () => token.connect(corps[0]).redeem(corpAmt, ref("CASH-OUT")))) redeemed += corpAmt;
      // issuer pays out fiat and lowers attested reserves accordingly
      await act(async () => token.attestReserves((await token.attestedReserves()) - redeemed));
      note("Redemption wave", `${runners.length} individuals and one corporate redeemed ${fmt(redeemed)} back to fiat. Supply and reserves fell together; backing stays at or above 100%.`);
    }

    await nextDay();
  }
  await snapshot();

  // ---------------------------------------------------------------------------------------
  // Index, reconcile, report
  // ---------------------------------------------------------------------------------------
  const { journal, assetJournal } = await indexLedger({ ethers, contracts: c, names });

  const holders = Object.keys(names);
  const balances = [];
  let sum = 0n;
  for (const a of holders) {
    const b = await token.balanceOf(a);
    sum += b;
    balances.push({ name: names[a], kind: kinds[a] || "SYSTEM", balance: b, frozen: await token.frozen(a), bonds: Number(await bond.balanceOf(a)) });
  }
  const supply = await token.totalSupply();
  const reserves = await token.attestedReserves();
  const checks = [
    { name: "Sum of all balances equals total supply", pass: sum === supply, detail: `${fmt(sum)} vs ${fmt(supply)}` },
    { name: "Supply fully backed by attested reserves", pass: supply <= reserves, detail: `backing ${(Number((reserves * 10000n) / supply) / 100).toFixed(2)}%` },
    {
      name: "Escrow cash equals locked + claimable",
      pass: (await token.balanceOf(await escrow.getAddress())) === (await escrow.totalLocked()) + (await escrow.totalClaimable()),
      detail: fmt(await token.balanceOf(await escrow.getAddress())),
    },
    { name: "PBM cash equals outstanding vouchers", pass: (await token.balanceOf(await pbm.getAddress())) === (await pbm.totalOutstanding()), detail: fmt(await pbm.totalOutstanding()) },
    { name: "DvP contract never custodies cash", pass: (await token.balanceOf(await dvp.getAddress())) === 0n, detail: fmt(await token.balanceOf(await dvp.getAddress())) },
  ];
  // journal replay must reproduce on-chain balances (double-entry reconciliation)
  const replay = {};
  for (const j of journal) {
    replay[j.from] = (replay[j.from] || 0n) - j.amount;
    replay[j.to] = (replay[j.to] || 0n) + j.amount;
  }
  const replayOk = balances.every((b) => (replay[b.name] || 0n) === b.balance);
  checks.push({ name: "Journal replay reproduces every on-chain balance", pass: replayOk, detail: `${journal.length} entries` });

  const volume = Object.fromEntries(CATEGORIES.map((k) => [k, { count: 0, amount: 0n }]));
  for (const j of journal) {
    volume[j.category].count++;
    volume[j.category].amount += j.amount;
  }

  const report = {
    meta: { seed: SEED, days: DAYS, generatedAt: new Date().toISOString(), network: hre.network.name, token: { name: await token.name(), symbol: await token.symbol() } },
    totals: { supply, reserves, participants: holders.length, transactions: attempts.ok + attempts.rejected, ...attempts },
    rejections,
    events,
    timeline,
    volume,
    balances: balances.sort((a, b) => (a.balance < b.balance ? 1 : -1)),
    checks,
    journal,
    assetJournal,
  };

  fs.mkdirSync(OUT, { recursive: true });
  const json = JSON.stringify(report, (_, v) => (typeof v === "bigint" ? ethers.formatUnits(v, 2) : v), 2);
  fs.writeFileSync(path.join(OUT, "report.json"), json);
  const csv = ["block,time,category,from,to,amount,ref"]
    .concat(journal.map((j) => [j.block, new Date(j.time * 1000).toISOString(), j.category, `"${j.from}"`, `"${j.to}"`, ethers.formatUnits(j.amount, 2), `"${j.ref}"`].join(",")))
    .join("\n");
  fs.writeFileSync(path.join(OUT, "journal.csv"), csv);
  fs.writeFileSync(path.join(OUT, "report.html"), renderReport(JSON.parse(json)));

  // Console summary
  console.log(`\nTokenized cash ledger simulation  (seed ${SEED}, ${DAYS} days)`);
  console.log("=".repeat(64));
  for (const e of events) console.log(`day ${String(e.day).padStart(2)}  [${e.scenario}] ${e.text}`);
  console.log("-".repeat(64));
  console.log(`Actions attempted: ${attempts.ok + attempts.rejected}  settled: ${attempts.ok}  rejected by ledger rules: ${attempts.rejected}`);
  console.log(`Rejections: ${Object.entries(rejections).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  console.log(`Supply ${fmt(supply)}  reserves ${fmt(reserves)}  journal entries ${journal.length}`);
  for (const ch of checks) console.log(`${ch.pass ? "PASS" : "FAIL"}  ${ch.name} (${ch.detail})`);
  console.log(`\nReport: ${path.relative(process.cwd(), path.join(OUT, "report.html"))}  (+ report.json, journal.csv)`);

  if (!checks.every((ch) => ch.pass)) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
