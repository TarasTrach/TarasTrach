// Renders assets/stats.svg from GitHub's own GraphQL API (contribution calendar).
// Runs daily via .github/workflows/stats.yml using the built-in GITHUB_TOKEN:
// no personal tokens, no third-party services, no dependencies.
// If anything fails, the script exits non-zero and the previous card stays untouched.
//
// Local test: STATS_FIXTURE=fixture.json node scripts/stats.mjs

import { readFile, writeFile, mkdir } from 'node:fs/promises';

const LOGIN = process.env.GH_LOGIN || 'TarasTrach';
const TOKEN = process.env.GITHUB_TOKEN;
const OUT_DIR = new URL('../assets/', import.meta.url);
const OUT_FILE = new URL('stats.svg', OUT_DIR);

const CALENDAR = 'contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } }';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

async function gql(query, variables = {}) {
  if (!TOKEN) throw new Error('GITHUB_TOKEN is not set');
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': `${LOGIN}-profile-stats`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.errors || !json.data) {
    throw new Error(`GraphQL ${res.status}: ${JSON.stringify(json.errors || json).slice(0, 400)}`);
  }
  return json.data;
}

async function load() {
  const meta = await gql(
    'query($login: String!) { user(login: $login) { contributionsCollection { contributionYears } } }',
    { login: LOGIN },
  );
  const years = meta.user.contributionsCollection.contributionYears;
  const now = new Date();
  const perYear = years.map((y) => {
    const from = `${y}-01-01T00:00:00Z`;
    const to = y === now.getUTCFullYear() ? now.toISOString() : `${y}-12-31T23:59:59Z`;
    return `y${y}: contributionsCollection(from: "${from}", to: "${to}") { ${CALENDAR} }`;
  });
  const data = await gql(
    `query($login: String!) { user(login: $login) { last: contributionsCollection { ${CALENDAR} } ${perYear.join(' ')} } }`,
    { login: LOGIN },
  );
  return { years, user: data.user };
}

const days = (calendar) => calendar.weeks.flatMap((w) => w.contributionDays);

function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function compute({ years, user }) {
  const lastDays = days(user.last.contributionCalendar);
  const byDate = new Map();
  for (const y of years) for (const d of days(user[`y${y}`].contributionCalendar)) byDate.set(d.date, d.contributionCount);
  for (const d of lastDays) byDate.set(d.date, d.contributionCount);

  const today = lastDays.length ? lastDays[lastDays.length - 1].date : new Date().toISOString().slice(0, 10);
  const first = [...byDate.keys()].sort()[0] || today;
  const count = (date) => byDate.get(date) || 0;

  let longest = 0;
  let run = 0;
  for (let d = first; d <= today; d = addDays(d, 1)) {
    run = count(d) > 0 ? run + 1 : 0;
    if (run > longest) longest = run;
  }

  let current = 0;
  let d = count(today) > 0 ? today : addDays(today, -1); // today's work may still be coming
  while (count(d) > 0) {
    current += 1;
    d = addDays(d, -1);
  }

  const monthly = new Map();
  for (const x of lastDays) {
    const key = x.date.slice(0, 7);
    monthly.set(key, (monthly.get(key) || 0) + x.contributionCount);
  }
  const months = [...monthly.keys()].sort().slice(-12).map((key) => ({ key, total: monthly.get(key) }));

  return {
    lastYear: user.last.contributionCalendar.totalContributions,
    allTime: years.reduce((sum, y) => sum + user[`y${y}`].contributionCalendar.totalContributions, 0),
    current,
    longest,
    months,
    stamp: today.slice(0, 7), // changes monthly, so the workflow commits at least once a month
  };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmt = (n) => n.toLocaleString('en-US');
const daysLabel = (n) => `${n} ${n === 1 ? 'day' : 'days'}`;

function render(s) {
  const metrics = [
    [fmt(s.lastYear), 'contributions · last year'],
    [daysLabel(s.current), 'current streak'],
    [daysLabel(s.longest), 'longest streak'],
    [fmt(s.allTime), 'all-time contributions'],
  ];
  const cells = metrics
    .map(([value, label], i) => {
      const x = 32 + (i % 2) * 182;
      const y = 112 + Math.floor(i / 2) * 82;
      return `<g class="m" style="animation-delay:${i * 90}ms"><text x="${x}" y="${y}" class="v">${esc(value)}</text><text x="${x}" y="${y + 22}" class="l">${esc(label)}</text></g>`;
    })
    .join('');

  const left = 436;
  const width = 376;
  const base = 196;
  const maxH = 116;
  const max = Math.max(1, ...s.months.map((m) => m.total));
  const slot = width / Math.max(1, s.months.length);
  const bw = Math.min(20, slot * 0.6);
  const bars = s.months
    .map((m, i) => {
      const h = m.total > 0 ? Math.max(4, Math.round((m.total / max) * maxH)) : 2;
      const x = left + i * slot + (slot - bw) / 2;
      const cx = (x + bw / 2).toFixed(1);
      const label = MONTHS[Number(m.key.slice(5, 7)) - 1];
      const value = m.total > 0 ? `<text x="${cx}" y="${base - h - 7}" class="n">${m.total}</text>` : '';
      return `<g class="b" style="animation-delay:${280 + i * 55}ms"><rect x="${x.toFixed(1)}" y="${base - h}" width="${bw.toFixed(1)}" height="${h}" rx="4" fill="url(#bar)"/>${value}</g><text x="${cx}" y="${base + 22}" class="mo">${label}</text>`;
    })
    .join('');

  const summary = `${fmt(s.lastYear)} contributions in the last year, current streak ${daysLabel(s.current)}, longest streak ${daysLabel(s.longest)}, ${fmt(s.allTime)} all-time.`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="840" height="250" viewBox="0 0 840 250" role="img" aria-labelledby="t d">
<!-- generated by scripts/stats.mjs · ${s.stamp} -->
<title id="t">GitHub activity of ${esc(LOGIN)}</title>
<desc id="d">${esc(summary)}</desc>
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0b1224"/><stop offset=".55" stop-color="#121a3d"/><stop offset="1" stop-color="#24124d"/></linearGradient>
<radialGradient id="glow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#7c3aed" stop-opacity=".35"/><stop offset="1" stop-color="#7c3aed" stop-opacity="0"/></radialGradient>
<linearGradient id="bar" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#2563eb"/><stop offset="1" stop-color="#a78bfa"/></linearGradient>
<clipPath id="card"><rect width="840" height="250" rx="16"/></clipPath>
</defs>
<style>
text{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif}
.t{font-size:12px;font-weight:700;letter-spacing:2px;fill:#93c5fd}
.s{font-size:12px;fill:#64748b;text-anchor:end}
.v{font-size:30px;font-weight:800;fill:#f8fafc}
.l{font-size:12px;fill:#94a3b8}
.n{font-size:10px;font-weight:600;fill:#cbd5e1;text-anchor:middle}
.mo{font-size:11px;fill:#64748b;text-anchor:middle}
.m{animation:fade .6s ease-out both}
.b{transform-box:fill-box;transform-origin:50% 100%;animation:grow .8s cubic-bezier(.2,.8,.2,1) both}
@keyframes fade{from{opacity:0}}
@keyframes grow{from{transform:scaleY(0)}}
@media (prefers-reduced-motion:reduce){.m,.b{animation:none}}
</style>
<g clip-path="url(#card)">
<rect width="840" height="250" fill="url(#bg)"/>
<circle cx="760" cy="20" r="190" fill="url(#glow)"/>
</g>
<rect x=".5" y=".5" width="839" height="249" rx="15.5" fill="none" stroke="#94a3b8" stroke-opacity=".18"/>
<text x="32" y="44" class="t">GITHUB ACTIVITY</text>
<text x="808" y="44" class="s">last 12 months</text>
${cells}
<line x1="404" y1="70" x2="404" y2="214" stroke="#334155" stroke-opacity=".7"/>
${bars}
</svg>
`;
}

async function main() {
  const data = process.env.STATS_FIXTURE ? JSON.parse(await readFile(process.env.STATS_FIXTURE, 'utf8')) : await load();
  const stats = compute(data);
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_FILE, render(stats));
  console.log(`stats.svg: last year ${stats.lastYear}, current ${stats.current}, longest ${stats.longest}, all-time ${stats.allTime}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
