// Renders the simulation report as one self-contained HTML file (no external dependencies).

function renderReport(data) {
  const payload = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ledger Simulation Report</title>
<style>
:root{
  --bg:#f6f7f9;--panel:#ffffff;--ink:#14171c;--muted:#5b6472;--line:#e3e6eb;
  --accent:#0f6e5c;--accent-soft:#e3f2ee;--warn:#b4531a;--bad:#b42318;--good:#13795b;
  --s1:#0f6e5c;--s2:#3b5bdb;--s3:#c2410c;--s4:#7c3aed;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){
  --bg:#0f1216;--panel:#171b21;--ink:#e7eaee;--muted:#98a2b0;--line:#2a3039;
  --accent:#4fc3a7;--accent-soft:#16302a;--warn:#f0a35e;--bad:#f37b6e;--good:#4fc3a7;
  --s1:#4fc3a7;--s2:#8ea4ff;--s3:#f39a5e;--s4:#b794f6;}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1180px;margin:0 auto;padding:28px 16px 64px}
header h1{font-size:24px;margin:0 0 4px;letter-spacing:-.01em}
header p{margin:0;color:var(--muted)}
.grid{display:grid;gap:14px}
.kpis{grid-template-columns:repeat(auto-fit,minmax(170px,1fr));margin:22px 0}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px}
.kpi .l{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.06em}
.kpi .v{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums;margin-top:4px}
.kpi .s{color:var(--muted);font-size:12px}
h2{font-size:15px;margin:0 0 12px}
.two{grid-template-columns:1.4fr 1fr}
@media (max-width:860px){.two{grid-template-columns:1fr}}
section{margin-top:14px}
.checks li{list-style:none;display:flex;gap:10px;align-items:baseline;padding:6px 0;border-bottom:1px solid var(--line)}
.checks{padding:0;margin:0}
.badge{font:600 11px var(--mono);padding:2px 7px;border-radius:5px}
.pass{background:var(--accent-soft);color:var(--good)}.fail{background:#fde8e6;color:var(--bad)}
.checks .d{margin-left:auto;color:var(--muted);font-family:var(--mono);font-size:12px;white-space:nowrap}
.log{max-height:360px;overflow:auto}
.log div{display:grid;grid-template-columns:52px 160px 1fr;gap:10px;padding:7px 0;border-bottom:1px solid var(--line)}
.log .day{font-family:var(--mono);color:var(--muted)}
.log .sc{font-weight:600;color:var(--accent)}
@media (max-width:640px){.log div{grid-template-columns:44px 1fr}.log .sc{grid-column:2}.log .tx{grid-column:2}}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
th{font-size:12px;color:var(--muted);font-weight:600;position:sticky;top:0;background:var(--panel)}
td.n,th.n{text-align:right}
.scroll{overflow:auto;max-height:440px}
.controls{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}
select,input{background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:7px;padding:6px 9px;font:inherit}
.cat{font:600 11px var(--mono);color:var(--muted)}
.legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--muted);margin-top:6px}
.legend i{display:inline-block;width:10px;height:3px;border-radius:2px;margin-right:5px;vertical-align:middle}
svg text{fill:var(--muted);font-size:11px}
.bars div{display:grid;grid-template-columns:120px 1fr 120px;gap:10px;align-items:center;padding:4px 0;font-size:13px}
.bars .t{height:12px;background:var(--accent-soft);border-radius:3px;overflow:hidden}
.bars .t span{display:block;height:100%;background:var(--accent)}
.bars .a{text-align:right;font-family:var(--mono);font-size:12px}
.frozen{color:var(--warn);font-weight:600}
footer{margin-top:26px;color:var(--muted);font-size:12px}
</style>
</head>
<body>
<main>
<header>
  <h1>Tokenized cash ledger: simulation report</h1>
  <p id="meta"></p>
</header>
<div class="grid kpis" id="kpis"></div>

<div class="grid two">
  <section class="card"><h2>Balances over time</h2><div id="chart"></div><div class="legend" id="legend"></div></section>
  <section class="card"><h2>Reconciliation</h2><ul class="checks" id="checks"></ul>
    <h2 style="margin-top:18px">Rejected by ledger rules</h2><div id="rej"></div></section>
</div>

<div class="grid two">
  <section class="card"><h2>Scenario log</h2><div class="log" id="log"></div></section>
  <section class="card"><h2>Cash volume by flow type</h2><div class="bars" id="bars"></div></section>
</div>

<section class="card"><h2>Balances</h2>
  <div class="controls"><select id="kind"><option value="">All participant types</option></select></div>
  <div class="scroll"><table id="bal"><thead><tr><th>Participant</th><th>Type</th><th class="n">Cash</th><th class="n">Bond units</th><th>Status</th></tr></thead><tbody></tbody></table></div>
</section>

<section class="card"><h2>Journal</h2>
  <div class="controls"><select id="cat"><option value="">All flow types</option></select><input id="q" placeholder="Search participant or reference" size="32"></div>
  <div class="scroll"><table id="jr"><thead><tr><th>Day</th><th>Type</th><th>From</th><th>To</th><th class="n">Amount</th><th>Reference</th></tr></thead><tbody></tbody></table></div>
  <p class="cat" id="jrcount"></p>
</section>
<footer>Generated by <code>sim/run.js</code>. Also written: <code>report.json</code>, <code>journal.csv</code>. Simulation on a local chain; all participants and amounts are fictional.</footer>
</main>
<script>
const D = ${payload};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const num = (s) => Number(s);
const money = (s) => num(s).toLocaleString("en-SG",{minimumFractionDigits:2,maximumFractionDigits:2});
const short = (v) => v>=1e6 ? (v/1e6).toFixed(v>=1e7?0:1)+"M" : v>=1e3 ? (v/1e3).toFixed(0)+"k" : String(Math.round(v));
const sym = D.meta.token.symbol;
const t0 = D.journal.length ? D.journal[0].time : 0;

$("meta").textContent = D.meta.token.name + " (" + sym + ") · seed " + D.meta.seed + " · " + D.meta.days + " simulated days · " + D.totals.participants + " ledger participants";

const backing = num(D.totals.reserves)/num(D.totals.supply)*100;
const kpis = [
  ["Supply", money(D.totals.supply), sym],
  ["Attested reserves", money(D.totals.reserves), "backing " + backing.toFixed(2) + "%"],
  ["Actions settled", D.totals.ok.toLocaleString(), D.journal.length.toLocaleString() + " cash movements"],
  ["Rejected by rules", D.totals.rejected.toLocaleString(), (D.totals.rejected/D.totals.transactions*100).toFixed(1) + "% of attempts"],
];
$("kpis").innerHTML = kpis.map(([l,v,s]) => '<div class="card kpi"><div class="l">'+l+'</div><div class="v">'+v+'</div><div class="s">'+esc(s)+'</div></div>').join("");

$("checks").innerHTML = D.checks.map((c) => '<li><span class="badge '+(c.pass?"pass":"fail")+'">'+(c.pass?"PASS":"FAIL")+'</span><span>'+esc(c.name)+'</span><span class="d">'+esc(c.detail)+'</span></li>').join("");
const rej = Object.entries(D.rejections).sort((a,b)=>b[1]-a[1]);
$("rej").innerHTML = rej.length ? '<table><tbody>'+rej.map(([k,v])=>'<tr><td><code>'+esc(k)+'</code></td><td class="n">'+v+'</td></tr>').join("")+'</tbody></table>' : '<p>None</p>';

$("log").innerHTML = D.events.map((e) => '<div><span class="day">day '+e.day+'</span><span class="sc">'+esc(e.scenario)+'</span><span class="tx">'+esc(e.text)+'</span></div>').join("");

// Line chart: three stacked panels sharing the day axis, each on its own scale
(function chart(){
  const tl = D.timeline, W = 640, P = {l:46,r:10,t:16,b:8};
  const maxDay = Math.max(...tl.map(p=>p.day));
  const x = (d) => P.l + (W-P.l-P.r) * d / Math.max(1,maxDay);
  const panels = [
    {h:150, title:"Supply vs attested reserves", series:[{k:"reserves",c:"var(--s2)",n:"Attested reserves",dash:"6 4"},{k:"supply",c:"var(--s1)",n:"Supply"}]},
    {h:100, title:"Locked in escrow", series:[{k:"escrowLocked",c:"var(--s3)",n:"Locked in escrow"}]},
    {h:100, title:"Outstanding vouchers", series:[{k:"pbmOutstanding",c:"var(--s4)",n:"Outstanding vouchers"}]},
  ];
  let yOff = 0, g = "";
  for (const pn of panels){
    const max = Math.max(1, ...pn.series.flatMap(s => tl.map(p => num(p[s.k])))) * 1.1;
    const y = (v) => yOff + P.t + (pn.h-P.t-P.b) * (1 - v/max);
    g += '<text x="'+P.l+'" y="'+(yOff+10)+'" style="font-weight:600">'+pn.title+'</text>';
    for (let i=0;i<=2;i++){ const v = max*i/2, yy = y(v); g += '<line x1="'+P.l+'" x2="'+(W-P.r)+'" y1="'+yy+'" y2="'+yy+'" stroke="var(--line)"/><text x="'+(P.l-6)+'" y="'+(yy+4)+'" text-anchor="end">'+short(v)+'</text>'; }
    for (const s of pn.series) g += '<polyline fill="none" stroke="'+s.c+'" stroke-width="2"'+(s.dash?' stroke-dasharray="'+s.dash+'"':'')+' points="'+tl.map(p => x(p.day)+","+y(num(p[s.k]))).join(" ")+'"/>';
    yOff += pn.h + 8;
  }
  for (let d=0; d<=maxDay; d+=2) g += '<text x="'+x(d)+'" y="'+(yOff+6)+'" text-anchor="middle">d'+d+'</text>';
  $("chart").innerHTML = '<svg viewBox="0 0 '+W+' '+(yOff+12)+'" width="100%" role="img" aria-label="Supply, reserves, escrow and voucher balances over time">'+g+'</svg>';
  $("legend").innerHTML = panels.flatMap(p=>p.series).map(s => '<span><i style="background:'+s.c+'"></i>'+s.n+'</span>').join("");
})();

const vol = Object.entries(D.volume).filter(([,v])=>v.count>0);
const vmax = Math.max(...vol.map(([,v])=>num(v.amount)));
$("bars").innerHTML = vol.map(([k,v]) => '<div><span class="cat">'+k+'</span><span class="t"><span style="width:'+(num(v.amount)/vmax*100).toFixed(1)+'%"></span></span><span class="a">'+short(num(v.amount))+' · '+v.count+'</span></div>').join("") + '<p class="cat">amount · number of movements</p>';

const kinds = [...new Set(D.balances.map(b=>b.kind))];
$("kind").innerHTML += kinds.map(k=>'<option>'+k+'</option>').join("");
function drawBalances(){
  const k = $("kind").value;
  $("bal").tBodies[0].innerHTML = D.balances.filter(b=>!k||b.kind===k).map(b => '<tr><td>'+esc(b.name)+'</td><td class="cat">'+b.kind+'</td><td class="n">'+money(b.balance)+'</td><td class="n">'+(b.bonds||"")+'</td><td>'+(b.frozen?'<span class="frozen">frozen</span>':"")+'</td></tr>').join("");
}
$("kind").onchange = drawBalances; drawBalances();

$("cat").innerHTML += Object.keys(D.volume).map(k=>'<option>'+k+'</option>').join("");
function drawJournal(){
  const c = $("cat").value, q = $("q").value.toLowerCase();
  const rows = D.journal.filter(j => (!c||j.category===c) && (!q || (j.from+" "+j.to+" "+j.ref).toLowerCase().includes(q)));
  $("jr").tBodies[0].innerHTML = rows.slice(0,500).map(j => '<tr><td>'+Math.floor((j.time-t0)/86400)+'</td><td class="cat">'+j.category+'</td><td>'+esc(j.from)+'</td><td>'+esc(j.to)+'</td><td class="n">'+money(j.amount)+'</td><td><code>'+esc(j.ref)+'</code></td></tr>').join("");
  $("jrcount").textContent = rows.length > 500 ? "Showing 500 of "+rows.length+" entries (full journal in journal.csv)" : rows.length+" entries";
}
$("cat").onchange = drawJournal; $("q").oninput = drawJournal; drawJournal();
</script>
</body>
</html>`;
}

module.exports = { renderReport };
