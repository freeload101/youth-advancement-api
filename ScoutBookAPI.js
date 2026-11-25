#!/usr/bin/env node
/**
 * =====================================================================================
 *  DOWNLOAD PIPELINE — BSA Scout Report Scraper
 * =====================================================================================
 *
 *  WHAT THIS DOES
 *  --------------
 *  This script automates the collection of Boy Scouts of America (BSA) advancement
 *  data for a single troop report. It performs, in order:
 *
 *    1. Authenticate  → POST to auth.scouting.org to obtain an API token.
 *    2. Download CSV  → Fetch the raw advancement report CSV from reportspd.scouting.org.
 *    3. Parse CSV     → Convert the messy raw CSV into a clean, merged JSON structure.
 *
 *  -------------------------------------------------------------------------
 *  USAGE
 *  -------------------------------------------------------------------------
 *    node ScoutBookAPI.js                 # Full run: authenticate → download → parse CSV
 *    node ScoutBookAPI.js --parse-only    # Skip auth/download; re-parse existing report-raw.csv
 *
 *  -------------------------------------------------------------------------
 *  CONFIGURATION
 *  -------------------------------------------------------------------------
 *  Credentials and endpoints are read from `config.yaml` (see config.example.yaml).
 *  IMPORTANT: `config.yaml` is git-ignored (see .gitignore) — commit
 *  `config.example.yaml` instead so secrets never reach the repo.
 *
 *  -------------------------------------------------------------------------
 *  OUTPUTS
 *  -------------------------------------------------------------------------
 *    report-raw.csv                     Raw CSV as downloaded from reportspd.scouting.org
 *    report-2185931-merged.json         Clean, structured advancement data (the main deliverable)
 *    logs/scraper.log                   Append-only log of every run
 *
 *  -------------------------------------------------------------------------
 *  DEPENDENCIES
 *  -------------------------------------------------------------------------
 *    js-yaml   Parse config.yaml
 *    (fs, path are Node built-ins.)
 *
 *  AUTHOR NOTE: Functions below are documented with JSDoc so this file is
 *  self-explanatory when reviewed on GitHub.
 * =====================================================================================
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// ── CONFIG LOADING ──────────────────────────────────────
// Load the YAML config once at startup. If config.yaml is missing or malformed the
// process will throw immediately on startup, which is intentional (fail fast, not at
// the first auth call deep inside a pipeline).
const cfg = yaml.load(fs.readFileSync(path.join(__dirname, 'config.yaml'), 'utf8'));

// ── REPORT CONSTANTS ────────────────────────────────────
// The troop/report identifier the reportspd endpoint serves. Change this to pull a
// different troop report. It is embedded in REPORTSPD_URL below and echoed into the
// merged-JSON output (reportId + output filename).
const REPORT_ID = '2185931';

// Endpoint that streams the raw CSV for the report above. The only dynamic value is
// ReportID; everything else is a fixed path on the BSA reportspd script server.
const REPORTSPD_URL = `https://reportspd.scouting.org/advancements/webscript/output/sbreports.aspx?Method=ExecuteScriptSet&ScriptSetCode=SBReportBuilderOutput&ScriptCode=PrintCSV&ReportID=${REPORT_ID}`;

// ── LOGGING / DIRECTORY SETUP ───────────────────────────
// Ensure the logs/ and images/ directories exist before anything writes to them.
const LOGS_DIR = path.join(__dirname, 'logs');
const IMG_DIR = path.join(__dirname, 'images');
[LOGS_DIR, IMG_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

/**
 * log — Write a timestamped message to both stdout and the append-only log file.
 *
 * @param {string} msg   Human-readable message to record.
 * @returns {void}
 *
 * NOTE: Every log line is mirrored to logs/scraper.log so failures can be
 * reconstructed later. Use log() (not console.log) for anything that should persist.
 */
const log = (msg) => {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
  fs.appendFileSync(path.join(LOGS_DIR, 'scraper.log'), `[${ts}] ${msg}\n`);
};

// ── STEP 1: Authenticate ────────────────────────────────
/**
 * authenticate — Exchange Scoutbook credentials for an API token + session token.
 *
 * Hits the auth.scouting.org user-authentication endpoint. The returned tokens are
 * required as a cookie when downloading the CSV in downloadCSV().
 *
 * @async
 * @returns {Promise<{token: string, sessionToken: string}>} The two tokens needed downstream.
 * @throws {Error} If the auth endpoint returns a non-2xx status (includes body snippet).
 */
async function authenticate() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  STEP 1: Authenticate');
  console.log('═══════════════════════════════════════════════════════');

  const res = await fetch(`https://auth.scouting.org/api/users/${cfg.scoutbook.user}/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json; version=2' },
    body: JSON.stringify({ password: cfg.scoutbook.password })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Auth failed (${res.status}): ${body.substring(0, 300)}`);
  }

  const data = await res.json();
  console.log(`✔ token=${data.token.substring(0, 12)}... session=${data.sessionToken.substring(0, 12)}...`);
  return { token: data.token, sessionToken: data.sessionToken };
}

// ── STEP 2: Download CSV ────────────────────────────────
/**
 * downloadCSV — Fetch the raw advancement CSV for REPORT_ID.
 *
 * Only the SessionToken cookie is required (verified empirically via curl). The CSV
 * is written verbatim to report-raw.csv for parseAndMerge() to consume.
 *
 * @async
 * @param {string} sessionToken  Session token returned by authenticate().
 * @returns {Promise<string>}    The raw CSV text.
 * @throws {Error} If the download fails (non-2xx) or the response is suspiciously small
 *                 (<100 bytes), which usually means an error page rather than real data.
 */
async function downloadCSV(sessionToken) {
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  STEP 2: Download CSV Report');
  console.log('═══════════════════════════════════════════════════════');

  // Minimal request: only the SessionToken cookie is required (verified via curl)
  const res = await fetch(REPORTSPD_URL, {
    headers: { Cookie: `SessionToken=${sessionToken}` },
    redirect: 'follow'
  });

  if (!res.ok) throw new Error(`CSV download failed (${res.status})`);

  const csv = await res.text();
  if (csv.length < 100) throw new Error(`CSV too small (${csv.length} bytes) — likely not real data`);

  const outPath = path.join(__dirname, 'report-raw.csv');
  fs.writeFileSync(outPath, csv);
  console.log(`✔ Saved ${outPath} (${csv.length} bytes)`);
  return csv;
}

// ── STEP 3: Parse CSV → Merged JSON ─────────────────────
/**
 * parseAndMerge — Transform the raw report CSV into a clean, merged JSON report.
 *
 * The raw CSV is a matrix: column 0 holds row labels (rank sections, requirement
 * numbers, metadata fields); each subsequent column is one scout. This function:
 *   1. Robustly parses CSV cells (handles quoted fields and escaped "").
 *   2. Detects which rank section each row belongs to (Scout → Eagle).
 *   3. Collects per-rank status/progress, then per-requirement completion.
 *   4. Pulls metadata (BSA member #, current rank, next rank) per scout.
 *   5. Writes report-<REPORT_ID>-merged.json.
 *
 * NOTE: CSV cells contain HTML fragments (e.g. "</a>" markers for unearned items);
 * all tags are stripped before values are stored.
 *
 * @returns {object} The merged report object (also written to disk).
 */
function parseAndMerge() {
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  STEP 3: Parse CSV → Merged JSON');
  console.log('═══════════════════════════════════════════════════════');

  const csv = fs.readFileSync('report-raw.csv', 'utf8');

  /**
   * parseCSVLine — Split a single CSV row into fields, honoring quotes.
   *
   * @param {string} line   One line of CSV text.
   * @returns {string[]}    The parsed fields.
   *
   * Handles: double-quoted cells, escaped quotes (""), and commas inside quotes.
   */
  function parseCSVLine(line) {
    const result = [];
    let current = '', inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
        else inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        result.push(current);
        current = '';
      } else current += ch;
    }
    result.push(current);
    return result;
  }

  const rows = csv.split('\n').filter(r => r.trim()).map(parseCSVLine);
  const maxCols = Math.max(...rows.map(r => r.length));

  // Maps the human rank label (as it appears in the CSV) to a normalized JSON key.
  const RANK_KEY_MAP = {
    'scout': 'scout', 'tenderfoot': 'tenderfoot',
    'second class': 'secondClass', 'first class': 'firstClass',
    'star scout': 'star', 'life scout': 'life', 'eagle scout': 'eagle'
  };

  /**
   * detectRankSection — Determine which rank a row label belongs to.
   *
   * @param {string} label  Raw row label (quotes stripped, trimmed, lowercased inside).
   * @returns {string|null} The normalized rank key, or null if the label is not a rank header.
   *
   * Matches exact labels and versioned variants like "First Class v2024".
   */
  function detectRankSection(label) {
    const clean = label.replace(/"/g, '').trim().toLowerCase();
    for (const [rankName, key] of Object.entries(RANK_KEY_MAP)) {
      if (clean === rankName || new RegExp('^' + rankName + '\\s+v\\d{4}$').test(clean)) {
        return key;
      }
    }
    return null;
  }

  /**
   * parseReqNumber — Extract a requirement number from a row label.
   *
   * @param {string} label  Raw row label (e.g. "Req #1", "req# 3.2").
   * @returns {string|null} The requirement number, or null if the label isn't a req line.
   */
  function parseReqNumber(label) {
    const m = label.replace(/"/g, '').trim().match(/^req\s*#?\s*(.+)$/i);
    return m ? m[1].trim() : null;
  }

  /**
   * parseStatus — Normalize a raw CSV cell into {status, progress}.
   *
   * @param {string} raw  Raw cell value (may contain HTML anchors or a "%").
   * @returns {{status: string|null, progress: string|null}}
   *
   * Rules: empty → both null; value ending in "%" → progress only; otherwise status only.
   */
  function parseStatus(raw) {
    if (!raw || raw.trim() === '') return { status: null, progress: null };
    const v = raw.replace(/<[^>]*>/g, '').trim(); // strip HTML anchors
    if (!v) return { status: null, progress: null };
    if (v.endsWith('%')) return { status: null, progress: v };
    return { status: v, progress: null };
  }

  // ── Build scouts array ────────────────────────────────
  const scouts = [];
  for (let col = 1; col < maxCols; col++) {
    const name = (rows[0][col] || 'Unknown').replace(/"/g, '').trim();

    // Pre-initialize every rank with empty status/progress/requirements.
    const finalRanks = {};
    for (const key of Object.values(RANK_KEY_MAP)) {
      finalRanks[key] = { status: null, progress: null, requirements: {} };
    }

    let currentRankKey = null;
    const seen = {};
    for (const key of Object.values(RANK_KEY_MAP)) seen[key] = {};

    // First pass: collect per-rank status/progress (last non-null value wins).
    for (let row = 1; row < rows.length; row++) {
      const rawLabel = rows[row][0] || '';
      const label = rawLabel.replace(/"/g, '').trim();
      if (!label) continue;

      const section = detectRankSection(label);
      const rawVal = (rows[row][col] || '').replace(/"/g, '').trim();

      if (section) {
        currentRankKey = section;
        const parsed = parseStatus(rawVal);
        if (parsed.status) finalRanks[currentRankKey].status = parsed.status;
        if (parsed.progress && !finalRanks[currentRankKey].progress) finalRanks[currentRankKey].progress = parsed.progress;
      }
    }

    // Second pass: collect requirements (first non-null value wins across versions).
    currentRankKey = null;
    for (let row = 1; row < rows.length; row++) {
      const rawLabel = rows[row][0] || '';
      const label = rawLabel.replace(/"/g, '').trim();
      if (!label) continue;

      const section = detectRankSection(label);
      const reqNum = parseReqNumber(rawLabel);
      const rawVal = (rows[row][col] || '').replace(/"/g, '').trim();

      if (section) {
        currentRankKey = section;
      } else if (reqNum && currentRankKey) {
        if (!seen[currentRankKey][reqNum]) {
          // CSV cells contain HTML fragments (e.g. "</a>" for unearned) — strip tags, empty → null
          const clean = rawVal.replace(/<[^>]*>/g, '').trim();
          finalRanks[currentRankKey].requirements[reqNum] = clean || null;
          seen[currentRankKey][reqNum] = true;
        }
      }
    }

    scouts.push({ name, bsaMemberNumber: null, currentRank: null, nextRank: null, ranks: finalRanks });
  }

  // ── Extract per-scout metadata fields ─────────────────
  // Metadata rows (BSA member #, current rank, next rank) live in column 0; for each
  // scout column we read the matching value.
  for (let si = 0; si < scouts.length; si++) {
    const col = si + 1;
    for (let row = 1; row < rows.length; row++) {
      const label = (rows[row][0] || '').replace(/"/g, '').trim().toLowerCase();
      const val = (rows[row][col] || '').replace(/"/g, '').trim();
      if (label === 'bsa member #' && !scouts[si].bsaMemberNumber) scouts[si].bsaMemberNumber = val || null;
      if (label === 'current rank' && !scouts[si].currentRank) scouts[si].currentRank = val || null;
      if (label === 'next rank' && !scouts[si].nextRank) scouts[si].nextRank = val || null;
    }
  }

  const output = {
    reportId: REPORT_ID,
    source: 'https://reportspd.scouting.org',
    generatedAt: new Date().toISOString(),
    scoutCount: scouts.length,
    scouts
  };

  fs.writeFileSync('report-2185931-merged.json', JSON.stringify(output, null, 2));

  let totalReqs = 0, filledReqs = 0;
  for (const s of scouts) {
    for (const rd of Object.values(s.ranks)) {
      totalReqs += Object.keys(rd.requirements).length;
      filledReqs += Object.values(rd.requirements).filter(v => v !== null).length;
    }
  }
  console.log(`✔ report-2185931-merged.json (${scouts.length} scouts, ${totalReqs} req fields, ${filledReqs} filled)`);

  // Convenience summary for a named scout (used as a sanity check).
  const miles = scouts.find(s => s.name === 'Miles Payne');
  if (miles) {
    const fc = miles.ranks.firstClass;
    const fcFilled = Object.values(fc.requirements).filter(v => v !== null).length;
    const fcTotal = Object.keys(fc.requirements).length;
    console.log(`  Miles Payne First Class: ${fcFilled}/${fcTotal} filled`);
  }

  return output;
}

// ── CLI MAIN ────────────────────────────────────────────
/**
 * CLI entrypoint — Dispatches based on argv flags.
 *
 *   --parse-only      → skip authenticate()/downloadCSV(); parse existing report-raw.csv.
 *   (none)            → full pipeline: authenticate → downloadCSV → parseAndMerge.
 *
 * Any pipeline failure prints the error + stack and exits with code 1.
 */
(async () => {
  const args = process.argv.slice(2);

  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║           DOWNLOAD PIPELINE: Scout Reports            ║');
  console.log('╚═══════════════════════════════════════════════════════╝\n');

  try {
    if (!args.includes('--parse-only')) {
      const { sessionToken } = await authenticate();
      await downloadCSV(sessionToken);
    }

    parseAndMerge();

    console.log('\n╔═══════════════════════════════════════════════════════╗');
    console.log('║              DOWNLOAD PIPELINE COMPLETE               ║');
    console.log('╚═══════════════════════════════════════════════════════╝');

  } catch (err) {
    console.error(`\n❌ PIPELINE FAILED: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }
})();

// ── EXPORTS (for require() usage) ───────────────────────
// Exported so other modules / tests can import individual pieces. `cfg` is exported
// for convenience in testing.
module.exports = { authenticate, downloadCSV, parseAndMerge, log, cfg };
