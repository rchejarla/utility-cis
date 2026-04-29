// Quick generator for testing the > 250 row async import path.
// Usage: node scripts/generate-meter-reads-csv.mjs > /tmp/reads-300.csv
//
// Produces 300 reads across the seeded meters (WM-001..GM-003 etc.)
// in chronological order per meter so the meter-read handler's
// consumption math stays sane.

// Only meters that are linked to a ServiceAgreement (SAs SA-0001 ..
// SA-0014 in the seed, indices 0-14). Meters 15-20 in the seed are
// not in any SA and would import as METER_NOT_ASSIGNED.
const meters = [
  "WM-001", "SM-001", "WM-002", "EM-001", "GM-001",
  "EM-002", "GM-002",
  "WM-003", "EM-003", "EM-004", "SM-002",
  "WM-004", "EM-005",
  "WM-005", "EM-006",
];

const ROWS = 300;
const PER_METER = Math.ceil(ROWS / meters.length); // 20 per meter
// Seeded SAs start 2025-01-01. Read dates must be on or after that to
// resolve through the SAM junction.
const startDate = new Date("2025-01-15T08:00:00Z");

const lines = ["meterNumber,readDatetime,reading"];
let count = 0;
outer: for (const m of meters) {
  let reading = 1000 + Math.floor(Math.random() * 500);
  for (let i = 0; i < PER_METER; i++) {
    if (count >= ROWS) break outer;
    // One read per day, 08:00 UTC, monotonically increasing.
    const ts = new Date(startDate.getTime() + (count) * 86400_000);
    reading += 5 + Math.floor(Math.random() * 20);
    lines.push(`${m},${ts.toISOString()},${reading}`);
    count++;
  }
}

process.stdout.write(lines.join("\n") + "\n");
