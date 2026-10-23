// Generates the profile stat cards (profile/*.svg) from the GitHub GraphQL API.
// Needs a token that can see private contributions:
//   GH_TOKEN=$(gh auth token) node scripts/generate-cards.mjs
import { mkdirSync, writeFileSync } from "node:fs";

const LOGIN = "inzamulhaque1";
const OUT_DIR = new URL("../profile/", import.meta.url);
const token = process.env.GH_TOKEN;
if (!token) throw new Error("GH_TOKEN is required");

const fonts = {
  font: "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
};
// GitHub's own dark and light palettes; the README picks one per viewer theme.
const palettes = {
  dark: { ...fonts, bg1: "#0d1117", border: "#30363d", text: "#e6edf3", muted: "#8b949e", blue: "#58a6ff" },
  light: { ...fonts, bg1: "#ffffff", border: "#d0d7de", text: "#1f2328", muted: "#59636e", blue: "#0969da" },
};
let theme = palettes.dark;

async function gql(query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (!res.ok || body.errors) throw new Error(`GraphQL failed: ${JSON.stringify(body.errors ?? body)}`);
  return body.data;
}

async function fetchCalendarDays(createdAt) {
  const days = [];
  const end = new Date();
  let from = new Date(createdAt);
  while (from < end) {
    const to = new Date(Math.min(from.getTime() + 365 * 86400000, end.getTime()));
    const data = await gql(
      `query($login:String!,$from:DateTime!,$to:DateTime!){user(login:$login){contributionsCollection(from:$from,to:$to){
        contributionCalendar{weeks{contributionDays{date contributionCount}}}}}}`,
      { login: LOGIN, from: from.toISOString(), to: to.toISOString() },
    );
    for (const w of data.user.contributionsCollection.contributionCalendar.weeks) days.push(...w.contributionDays);
    from = new Date(to.getTime() + 1000);
  }
  // Windows can overlap by a day at the seams; keep one entry per date.
  const byDate = new Map(days.map((d) => [d.date, d.contributionCount]));
  return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function streaks(days) {
  let longest = { len: 0, start: "", end: "" };
  let run = { len: 0, start: "" };
  for (const [date, count] of days) {
    if (count > 0) {
      run = run.len ? { len: run.len + 1, start: run.start } : { len: 1, start: date };
      if (run.len > longest.len) longest = { len: run.len, start: run.start, end: date };
    } else run = { len: 0, start: "" };
  }
  // Today with no contributions yet doesn't break the current streak.
  let i = days.length - 1;
  if (i >= 0 && days[i][1] === 0) i--;
  let current = 0;
  let currentStart = "";
  while (i >= 0 && days[i][1] > 0) {
    current++;
    currentStart = days[i][0];
    i--;
  }
  return { current, currentStart, longest };
}

async function fetchLanguages() {
  const totals = new Map();
  let cursor = null;
  do {
    const data = await gql(
      `query($login:String!,$cursor:String){user(login:$login){repositories(ownerAffiliations:OWNER,isFork:false,first:100,after:$cursor){
        pageInfo{hasNextPage endCursor}
        nodes{languages(first:20,orderBy:{field:SIZE,direction:DESC}){edges{size node{name color}}}}}}}`,
      { login: LOGIN, cursor },
    );
    const repos = data.user.repositories;
    for (const repo of repos.nodes)
      for (const e of repo.languages.edges) {
        const prev = totals.get(e.node.name) ?? { size: 0, color: e.node.color ?? theme.muted };
        totals.set(e.node.name, { size: prev.size + e.size, color: prev.color });
      }
    cursor = repos.pageInfo.hasNextPage ? repos.pageInfo.endCursor : null;
  } while (cursor);
  const sum = [...totals.values()].reduce((a, b) => a + b.size, 0);
  const sorted = [...totals.entries()].map(([name, v]) => ({ name, color: v.color, pct: (v.size / sum) * 100 }))
    .sort((a, b) => b.pct - a.pct);
  const top = sorted.slice(0, 7);
  const rest = sorted.slice(7).reduce((a, b) => a + b.pct, 0);
  if (rest > 0) top.push({ name: "Other", color: "#6e7681", pct: rest });
  return top;
}

async function fetchCounts() {
  const data = await gql(
    `query($login:String!){user(login:$login){
      repositories(ownerAffiliations:OWNER){totalCount}
      pullRequests{totalCount}
      merged: pullRequests(states:MERGED){totalCount}}}`,
    { login: LOGIN },
  );
  return {
    repos: data.user.repositories.totalCount,
    prs: data.user.pullRequests.totalCount,
    merged: data.user.merged.totalCount,
  };
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const num = (n) => n.toLocaleString("en-US");
const fmtDate = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const fmtRange = (a, b) => `${fmtDate(a)} – ${fmtDate(b)}, ${b.slice(0, 4)}`;

function frame(w, h, title, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">
<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="12" fill="${theme.bg1}" stroke="${theme.border}"/>
<text x="28" y="40" fill="${theme.text}" font-family="${theme.font}" font-size="17" font-weight="600">${esc(title)}</text>
${body}
</svg>`;
}

function statsCard({ lastYear, allTime, streak, counts }) {
  const cells = [
    { value: num(lastYear), label: "Contributions", sub: "last 12 months" },
    { value: num(allTime), label: "All-time", sub: "contributions" },
    { value: `${streak.current}`, label: "Current streak", sub: streak.current ? `since ${fmtDate(streak.currentStart)}` : "days", accent: true },
    { value: `${streak.longest.len}`, label: "Longest streak", sub: fmtRange(streak.longest.start, streak.longest.end) },
    { value: num(counts.prs), label: "Pull requests", sub: `${num(counts.merged)} merged` },
    { value: num(counts.repos), label: "Repositories", sub: "created" },
  ];
  const w = 900, cw = (w - 56) / cells.length;
  const body = cells.map((c, i) => {
    const x = 28 + i * cw + cw / 2;
    const sep = i ? `<line x1="${28 + i * cw}" y1="72" x2="${28 + i * cw}" y2="150" stroke="${theme.border}"/>` : "";
    return `${sep}
<text x="${x}" y="108" text-anchor="middle" fill="${c.accent ? theme.blue : theme.text}" font-family="${theme.font}" font-size="30" font-weight="700">${esc(c.value)}</text>
<text x="${x}" y="132" text-anchor="middle" fill="${theme.text}" font-family="${theme.font}" font-size="13">${esc(c.label)}</text>
<text x="${x}" y="150" text-anchor="middle" fill="${theme.muted}" font-family="${theme.mono}" font-size="10">${esc(c.sub)}</text>`;
  }).join("\n");
  return frame(w, 180, "GitHub activity", body);
}

function languagesCard(langs) {
  const w = 440, barX = 28, barW = w - 56;
  let x = barX;
  const segs = langs.map((l) => {
    const sw = (l.pct / 100) * barW;
    const r = `<rect x="${x}" y="62" width="${Math.max(sw, 0)}" height="10" fill="${l.color}"/>`;
    x += sw;
    return r;
  }).join("");
  const items = langs.map((l, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const ix = 28 + col * 200, iy = 104 + row * 26;
    return `<circle cx="${ix + 5}" cy="${iy - 4}" r="5" fill="${l.color}"/>
<text x="${ix + 16}" y="${iy}" fill="${theme.text}" font-family="${theme.font}" font-size="13">${esc(l.name)}</text>
<text x="${ix + 180}" y="${iy}" text-anchor="end" fill="${theme.muted}" font-family="${theme.mono}" font-size="12">${l.pct.toFixed(1)}%</text>`;
  }).join("\n");
  const body = `<clipPath id="bar"><rect x="${barX}" y="62" width="${barW}" height="10" rx="5"/></clipPath>
<g clip-path="url(#bar)">${segs}</g>
${items}`;
  return frame(w, 236, "Languages", body);
}

function activityCard(days) {
  const months = new Map();
  for (const [date, count] of days.slice(-365)) {
    const key = date.slice(0, 7);
    months.set(key, (months.get(key) ?? 0) + count);
  }
  const entries = [...months.entries()].slice(-12);
  const max = Math.max(1, ...entries.map(([, v]) => v));
  const w = 440, chartX = 28, chartW = w - 56, baseY = 196, chartH = 120;
  const step = chartW / entries.length, bw = step * 0.62;
  const bars = entries.map(([key, v], i) => {
    const h = Math.max(2, (v / max) * chartH);
    const x = chartX + i * step + (step - bw) / 2;
    const label = new Date(`${key}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
    return `<rect x="${x.toFixed(1)}" y="${(baseY - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${theme.blue}"><title>${label}: ${v}</title></rect>
<text x="${(x + bw / 2).toFixed(1)}" y="${baseY + 16}" text-anchor="middle" fill="${theme.muted}" font-family="${theme.mono}" font-size="9">${label}</text>`;
  }).join("\n");
  return frame(w, 236, "Contributions per month", bars);
}

const { user } = await gql(`query($login:String!){user(login:$login){createdAt}}`, { login: LOGIN });
const days = await fetchCalendarDays(user.createdAt);
const lastYear = days.slice(-365).reduce((a, [, c]) => a + c, 0);
const allTime = days.reduce((a, [, c]) => a + c, 0);
const streak = streaks(days);
const [langs, counts] = await Promise.all([fetchLanguages(), fetchCounts()]);

mkdirSync(OUT_DIR, { recursive: true });
for (const [mode, palette] of Object.entries(palettes)) {
  theme = palette;
  writeFileSync(new URL(`stats-${mode}.svg`, OUT_DIR), statsCard({ lastYear, allTime, streak, counts }));
  writeFileSync(new URL(`languages-${mode}.svg`, OUT_DIR), languagesCard(langs));
  writeFileSync(new URL(`activity-${mode}.svg`, OUT_DIR), activityCard(days));
}
console.log(JSON.stringify({ lastYear, allTime, streak, counts, langs: langs.map((l) => `${l.name} ${l.pct.toFixed(1)}%`) }));
