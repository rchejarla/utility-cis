"""Regenerate docs/bozeman/00-requirements-master.md from the source RFP xlsx.

Usage:
  python docs/bozeman/_tools/regenerate-master.py

The xlsx is private RFP content and stays outside the repo. This script
copies it to a gitignored dotfile, parses it via openpyxl, applies the
hand-curated Req->doc mapping in coverage(), and writes the master
cross-reference at docs/bozeman/00-requirements-master.md.

When you change a bz/ doc's scope or add a new bz/ doc, update coverage()
and BZ_TITLES/BZ_FILES below; rerun the script to refresh the master.

Required: openpyxl (pip install openpyxl).
"""
import json
import shutil
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')

# Source xlsx — update when it moves
SRC_XLSX = (
    r"C:\Users\RaoChejarla\Expeed Software\ExpeedSoftware - USA - Documents"
    r"\Sales_ Business Development\Prospective client files\City of Bozeman, MT"
    r"\Saaslogic RFP- Bozeman MT\bozeman-proposal\01_Functional_Requirements_Expeed.xlsx"
)
PROJECT_ROOT = Path(r"C:\development\claude-test")
LOCAL_XLSX = PROJECT_ROOT / ".expeed_reqs.xlsx"
LOCAL_JSON = PROJECT_ROOT / ".expeed_reqs.json"
OUTPUT = PROJECT_ROOT / "docs" / "bozeman" / "00-requirements-master.md"


def extract_xlsx():
    import openpyxl
    shutil.copy2(SRC_XLSX, LOCAL_XLSX)
    wb = openpyxl.load_workbook(LOCAL_XLSX, data_only=True)
    ws = wb["Functional Requirements"]
    out = []
    for i, row in enumerate(ws.iter_rows(values_only=True)):
        if i < 3:
            continue
        if row[0] is None or str(row[0]).strip() == "":
            continue
        out.append({
            "req": str(row[0]).strip(),
            "area": (str(row[1]).strip() if row[1] else ""),
            "process": (str(row[2]).strip() if row[2] else ""),
            "story": (str(row[3]).strip() if row[3] else ""),
            "response": (str(row[4]).strip() if row[4] else ""),
            "module": (str(row[5]).strip() if row[5] else ""),
            "phase": (str(row[6]).strip() if row[6] else ""),
            "comment": (str(row[7]).strip() if row[7] else ""),
        })
    LOCAL_JSON.write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")
    return out


reqs = extract_xlsx()

BZ_TITLES = {
    "01": "Audit & Tamper-Evidence",
    "02": "Mobile & Responsive UI",
    "03": "Progressive Web App",
    "04": "Attachments",
    "05": "Customer Portal",
    "06": "Custom Fields",
    "07": "Data Validation",
    "08": "Data Retention, Archival & Purge",
    "09": "Bulk Upload & Data Ingestion",
    "10": "Draft Status & Posting",
    "11": "Notes & Comments",
    "12": "Corrections & Reversals",
    "13": "Workflow, Approvals & Action Queue",
    "14": "Special Assessments",
    "15": "GIS-Driven Defaults & Effective-Dating",
    "16": "Wastewater Billing & WQA",
}
BZ_FILES = {
    "01": "01-audit-and-tamper-evidence.md",
    "02": "02-mobile-and-responsive-ui.md",
    "03": "03-progressive-web-app.md",
    "04": "04-attachments.md",
    "05": "05-customer-portal.md",
    "06": "06-custom-fields.md",
    "07": "07-data-validation.md",
    "08": "08-data-retention-archival-purge.md",
    "09": "09-bulk-upload-and-data-ingestion.md",
    "10": "10-draft-status-and-posting.md",
    "11": "11-notes-and-comments.md",
    "12": "12-corrections-and-reversals.md",
    "13": "13-workflow-approvals-action-queue.md",
    "14": "14-special-assessments.md",
    "15": "15-gis-driven-defaults-and-effective-dating.md",
    "16": "16-wastewater-billing-and-wqa.md",
}
SP_TITLES = {
    "01": "Customer Management", "02": "Premise Management", "03": "Meter Management",
    "04": "Account Management", "05": "Service Agreement", "06": "Commodity & UoM",
    "07": "Rate Management", "08": "Meter Reading", "09": "Billing",
    "10": "Payments & Collections", "11": "Delinquency", "12": "Solid Waste",
    "13": "Notifications", "14": "Service Requests", "15": "Customer Portal",
    "16": "Special Assessments", "17": "Reporting & Audit", "18": "Theme & Configuration",
    "19": "RBAC", "20": "Custom Fields", "21": "SaaSLogic Billing",
}
SP_FILES = {k: f"{k}-{n.lower().replace(' & ', '-and-').replace(' ', '-').replace('.', '')}.md"
            for k, n in SP_TITLES.items()}
# Manual override since title-derived names won't match exactly
SP_FILES = {
    "01": "01-customer-management.md", "02": "02-premise-management.md",
    "03": "03-meter-management.md", "04": "04-account-management.md",
    "05": "05-service-agreement.md", "06": "06-commodity-and-uom.md",
    "07": "07-rate-management.md", "08": "08-meter-reading.md",
    "09": "09-billing.md", "10": "10-payments-and-collections.md",
    "11": "11-delinquency.md", "12": "12-solid-waste.md",
    "13": "13-notifications.md", "14": "14-service-requests.md",
    "15": "15-customer-portal.md", "16": "16-special-assessments.md",
    "17": "17-reporting-and-audit.md", "18": "18-theme-and-configuration.md",
    "19": "19-rbac.md", "20": "20-custom-fields.md",
    "21": "21-saaslogic-billing.md",
}


def coverage(req):
    """Hand-curated mapping; only assert bz/ when the doc actually frames the requirement."""
    n = int(req["req"])
    bz, sp, pl = [], [], []

    # Customer - Property File
    if 1 <= n <= 4:
        bz += ["14"]; sp += ["02"]
    elif n == 5:
        bz += ["15"]; sp += ["05"]; pl += ["2026-04-26-effective-dating-constraints"]
    elif n == 6:
        bz += ["15"]; sp += ["07"]
    elif n == 7:
        bz += ["15", "01"]; sp += ["02"]
    elif n == 8:
        sp += ["02"]
    elif 9 <= n <= 13:
        bz += ["15"]; sp += ["01", "04", "05"]
    elif n == 14:
        bz += ["05"]; sp += ["01", "04"]
    elif n == 15:
        bz += ["15"]; sp += ["05"]
    elif n in (16, 17):
        sp += ["01", "04"]
    elif 18 <= n <= 24:
        sp += ["01", "04"]
    elif n == 25:
        bz += ["01", "08", "15"]; sp += ["17"]
    elif n == 26:
        bz += ["01", "08"]; sp += ["17"]
    elif n == 27:
        bz += ["13"]; sp += ["13"]
    elif n == 28:
        bz += ["13"]; sp += ["13"]
    elif n == 29:
        bz += ["13"]; sp += ["13"]
    elif n == 30:
        bz += ["01", "13"]; sp += ["13"]
    elif n == 31:
        bz += ["13", "05"]; sp += ["13"]
    elif n == 32:
        bz += ["13", "05"]; sp += ["13"]  # FIX: communication preferences
    elif n == 33:
        bz += ["13"]; sp += ["13"]
    elif 34 <= n <= 36:
        bz += ["05"]; sp += ["15"]
    elif n == 37:
        bz += ["05", "13"]; sp += ["15"]
    elif 38 <= n <= 39:
        bz += ["05"]; sp += ["15"]
    elif n == 40:
        bz += ["05"]; sp += ["10", "15"]
    elif n == 41:
        bz += ["05", "13"]; sp += ["13", "15"]

    # Solid Waste
    elif n == 42:
        bz += ["15"]; sp += ["12"]
    elif n == 43:
        sp += ["12"]
    elif n == 44:
        bz += ["15"]; sp += ["12"]  # FIX: effective-dated enrollment
    elif 45 <= n <= 46:
        sp += ["12"]
    elif n == 47:
        bz += ["13"]; sp += ["12"]
    elif n == 48:
        sp += ["12"]
    elif n == 49:
        bz += ["13"]; sp += ["12"]  # FIX: workflow trigger on RAMS completion
    elif 50 <= n <= 51:
        sp += ["12"]
    elif n == 52:
        bz += ["15"]; sp += ["12"]  # FIX: container effective-date tracking
    elif n == 53:
        sp += ["12"]
    elif n == 54:
        bz += ["12"]; sp += ["12"]  # FIX: dispute workflows -> corrections
    elif n == 55:
        bz += ["15"]; sp += ["12"]  # FIX: authorized overrides with audit
    elif n == 56:
        sp += ["12"]
    elif n == 57:
        sp += ["07", "12"]
    elif n == 58:
        bz += ["15"]; sp += ["07", "12"]  # FIX: future-dated rate changes
    elif n == 59:
        bz += ["12"]; sp += ["07", "12"]  # FIX: missed-collection adjustments

    # Water/Wastewater & Stormwater
    elif n == 60:
        sp += ["02", "05", "06"]
    elif n == 61:
        sp += ["09"]
    elif n == 62:
        bz += ["15"]; sp += ["05"]  # FIX: effective-dated water enrollment
    elif n == 63:
        sp += ["03"]
    elif n == 64:
        bz += ["15"]; sp += ["05"]
    elif n in (65, 66, 67):
        bz += ["15"]; sp += ["07"]
    elif n == 68:
        bz += ["15"]; sp += ["07"]  # FIX: future-dated rate ordinances
    elif 69 <= n <= 73:
        bz += ["16"]; sp += ["07", "09"]  # NEW: WQA wastewater billing
    elif n == 74:
        sp += ["07", "09"]
    elif 75 <= n <= 76:
        sp += ["08"]
    elif n == 77:
        bz += ["09"]; sp += ["08"]  # FIX: incremental + full read imports
    elif 78 <= n <= 80:
        sp += ["08"]
    elif n in (81, 82):
        bz += ["09"]; sp += ["08"]
    elif n == 83:
        bz += ["09"]; sp += ["08"]  # FIX: raw interval read ingestion
    elif n == 84:
        sp += ["08"]
    elif n == 85:
        bz += ["13"]; sp += ["08"]  # FIX: events trigger notifications/holds
    elif n == 86:
        sp += ["08"]
    elif n == 87:
        bz += ["12"]; sp += ["08"]  # FIX: before/after for corrected reads
    elif n == 88:
        bz += ["01"]; sp += ["08"]  # FIX: audit trail of reads + edits
    elif n == 89:
        bz += ["15", "01"]; sp += ["08"]  # FIX: manual entry/correction with audit
    elif n == 90:
        bz += ["15"]; sp += ["03", "05"]; pl += ["2026-04-26-effective-dating-constraints"]
    elif n == 91:
        bz += ["15"]; sp += ["03", "05"]; pl += ["2026-04-26-effective-dating-constraints"]
    elif n == 92:
        bz += ["15"]; sp += ["03", "05"]; pl += ["2026-04-26-effective-dating-constraints"]
    elif 93 <= n <= 100:
        bz += ["07"]; sp += ["08"]
    elif n in (101, 102):
        sp += ["07", "08", "09"]
    elif n == 103:
        bz += ["12"]; sp += ["07", "08", "09"]  # FIX: controlled rebilling of corrected reads
    elif n == 104:
        sp += ["07", "08", "09", "17"]
    elif n == 105:
        bz += ["01"]; sp += ["07", "08", "09", "17"]  # FIX: calculation audit trails
    elif n == 106:
        sp += ["03"]
    elif n == 107:
        bz += ["09"]; sp += ["03"]
    elif 108 <= n <= 109:
        sp += ["03"]
    elif n == 110:
        bz += ["01"]; sp += ["03"]  # FIX: chain-of-custody (audit)
    elif n == 111:
        bz += ["15"]; sp += ["03", "05"]; pl += ["2026-04-26-effective-dating-constraints"]
    elif 112 <= n <= 115:
        sp += ["03"]
    elif n == 116:
        bz += ["15"]; sp += ["03"]; pl += ["2026-04-26-effective-dating-constraints"]
    elif 117 <= n <= 123:
        sp += ["03"]
    elif n == 124:
        bz += ["13"]; sp += ["11"]
    elif n == 125:
        bz += ["13"]; sp += ["11", "13"]
    elif n == 126:
        bz += ["13"]; sp += ["11"]
    elif n == 127:
        bz += ["06"]; sp += ["17"]

    # Billing
    elif 128 <= n <= 130:
        bz += ["05"]; sp += ["09", "15"]
    elif n == 131:
        sp += ["09"]
    elif n == 132:
        sp += ["09", "15"]
    elif n == 133:
        bz += ["12"]; sp += ["09"]  # FIX: bill reprints with version tracking
    elif n == 134:
        bz += ["15"]; sp += ["05", "09"]  # FIX: final bill at closure (transferService)
    elif n == 135:
        sp += ["09"]
    elif n == 136:
        bz += ["12"]; sp += ["09"]  # FIX: bill holds
    elif n == 137:
        sp += ["09"]
    elif 138 <= n <= 141:
        sp += ["07", "09", "21"]
    elif n == 142:
        bz += ["12"]; sp += ["09"]
    elif n in (143, 144):
        bz += ["12"]; sp += ["10"]
    elif n == 145:
        bz += ["13"]; sp += ["11"]
    elif n == 146:
        bz += ["12"]; sp += ["10"]
    elif n in (147,):
        sp += ["10"]
    elif n == 148:
        bz += ["13"]; sp += ["10", "13"]  # FIX: payment plan notifications
    elif n == 149:
        bz += ["13"]; sp += ["11", "17"]  # FIX: aging dashboard widget
    elif 150 <= n <= 151:
        bz += ["13"]; sp += ["11"]
    elif n == 152:
        bz += ["05"]; sp += ["15"]
    elif n == 153:
        bz += ["05"]; sp += ["15"]
    elif n in (154, 155):
        sp += ["10"]
    elif n == 156:
        bz += ["05"]; sp += ["10", "15"]  # FIX: portal payment history
    elif n == 157:
        sp += ["10", "21"]
    elif n == 158:
        sp += ["10", "21"]
    elif n == 159:
        sp += ["10", "21"]
    elif n == 160:
        bz += ["13"]; sp += ["13"]  # FIX: payment confirmations
    elif n == 161:
        sp += ["10", "17"]
    elif n == 162:
        bz += ["13"]; sp += ["10"]  # FIX: POS integration via call_external
    elif n == 163:
        bz += ["12"]; sp += ["10", "21"]  # FIX: auto payment reversal handling (NSF)
    elif n == 164:
        sp += ["10", "21"]

    # Special Assessments
    elif n in (165, 166, 167):
        bz += ["14"]; sp += ["16"]
    elif 168 <= n <= 171:
        bz += ["14", "15"]; sp += ["16"]
    elif 172 <= n <= 175:
        bz += ["14"]; sp += ["16"]
    elif n == 176:
        bz += ["14"]; sp += ["16"]
    elif n == 177:
        bz += ["14", "05"]; sp += ["16", "15"]
    elif n in (178, 179):
        bz += ["14"]; sp += ["16"]

    # Service Requests
    elif n == 180:
        bz += ["05"]; sp += ["14"]
    elif n == 181:
        bz += ["15"]; sp += ["14"]  # FIX: SR -> GIS properties
    elif 182 <= n <= 183:
        sp += ["14"]
    elif n == 184:
        bz += ["04", "11"]; sp += ["14"]  # FIX: attachments + notes for SRs
    elif n == 185:
        sp += ["14"]
    elif n == 186:
        bz += ["13"]; sp += ["14"]  # FIX: SR assignment -> Task action queue
    elif n in (187, 188):
        bz += ["13"]; sp += ["14"]
    elif 189 <= n <= 192:
        bz += ["13"]; sp += ["14"]
    elif n in (193, 194):
        sp += ["14"]
    elif n == 195:
        bz += ["12"]; sp += ["14"]  # FIX: dispute handling for SR charges
    elif n == 196:
        bz += ["01"]; sp += ["14"]  # FIX: full audit trail for SRs
    elif n == 197:
        sp += ["14", "17"]
    elif n in (198, 199):
        bz += ["13"]; sp += ["11", "14"]  # FIX: workflow rules trigger SR creation
    elif n == 200:
        bz += ["13", "12"]; sp += ["10", "14"]  # FIX: charges/credits on SR completion
    elif n == 201:
        bz += ["12"]; sp += ["10", "14"]
    elif n == 202:
        bz += ["11"]; sp += ["14"]

    return sorted(set(bz)), sorted(set(sp)), sorted(set(pl))


for r in reqs:
    bz, sp, pl = coverage(r)
    r["bz"] = bz
    r["sp"] = sp
    r["pl"] = pl


def bz_link(num):
    return f"[bz/{num}](./{BZ_FILES[num]})"


def sp_link(num):
    return f"[sp/{num}](../specs/{SP_FILES[num]})"


def pl_link(slug):
    return f"[plan/{slug[:10]}](../superpowers/plans/{slug}.md)"


def truncate(s, n):
    if not s:
        return ""
    s = s.replace("‑", "-").replace("–", "-").replace("—", "-")
    s = s.replace("‘", "'").replace("’", "'")
    s = s.replace("“", '"').replace("”", '"')
    s = s.replace("|", "\\|")
    if len(s) <= n:
        return s
    return s[:n].rsplit(" ", 1)[0] + "..."


def normalize(s):
    if not s:
        return ""
    s = s.replace("‑", "-").replace("–", "-").replace("—", "-")
    s = s.replace("‘", "'").replace("’", "'")
    s = s.replace("“", '"').replace("”", '"')
    return s


lines = []
lines.append("# Bozeman BUBSSI RFP — Master Requirements Cross-Reference")
lines.append("")
lines.append("**Source:** `01_Functional_Requirements_Expeed.xlsx` (snapshot from `bozeman-proposal/` on 2026-04-26)  ")
lines.append(f"**Total requirements:** {len(reqs)} (all answered Y or Y-WC)  ")
lines.append("**Purpose:** Single working list mapping every Bozeman Req # to (a) the `bozeman/` proposal-response doc that frames it for the City, (b) the `docs/specs/` module spec that owns the engineering scope, and (c) any `docs/superpowers/plans/` implementation plan written. Use this to find what's drafted vs. what still needs work, and which doc to update when scope shifts.")
lines.append("")
lines.append("**Conventions:**")
lines.append("- `bz/NN` -> `docs/bozeman/NN-*.md` (RFP proposal-response)")
lines.append("- `sp/NN` -> `docs/specs/NN-*.md` (long-lived module functional spec)")
lines.append("- `plan/<date>` -> `docs/superpowers/plans/<date>-*.md` (implementation plan)")
lines.append("")
lines.append("**Regeneration:** `python .gen_xref.py` from the project root (after refreshing `.expeed_reqs.json` from the source xlsx).")
lines.append("")

# Stats
lines.append("## 1. Summary")
lines.append("")
resp = Counter(r["response"] for r in reqs)
phase = Counter(r["phase"] for r in reqs)
area = Counter(r["area"] for r in reqs)

lines.append("**Coverage by document:**")
lines.append("")
lines.append("| Metric | Count |")
lines.append("|---|---|")
lines.append(f"| Total requirements | {len(reqs)} |")
lines.append(f"| Answered **Y** (binding, OOTB / config) | {resp.get('Y', 0)} |")
lines.append(f"| Answered **Y-WC** (Yes with conditions) | {resp.get('Y-WC', 0)} |")
lines.append(f"| Mapped to a `bz/` proposal-response doc | {sum(1 for r in reqs if r['bz'])} |")
lines.append(f"| Mapped to a `sp/` module spec | {sum(1 for r in reqs if r['sp'])} |")
lines.append(f"| Mapped to an implementation plan | {sum(1 for r in reqs if r['pl'])} |")
lines.append("")

lines.append("**Phase distribution** (per Expeed's RFP response):")
lines.append("")
for p in sorted(phase.keys()):
    lines.append(f"- Phase **{p}**: {phase[p]} reqs")
lines.append("")

lines.append("**By functional area:**")
lines.append("")
for a, c in area.most_common():
    lines.append(f"- {a}: **{c}** reqs")
lines.append("")

bz_usage = Counter()
for r in reqs:
    for b in r["bz"]:
        bz_usage[b] += 1
lines.append("**`bz/` doc usage** (which proposal-response docs cover the most reqs):")
lines.append("")
lines.append("| Doc | Title | Reqs covered |")
lines.append("|---|---|---|")
for b, c in sorted(bz_usage.items(), key=lambda x: -x[1]):
    lines.append(f"| `bz/{b}` | {BZ_TITLES[b]} | {c} |")
lines.append("")

no_bz = [r for r in reqs if not r["bz"]]
lines.append(f"## 2. Requirements covered by module spec only ({len(no_bz)})")
lines.append("")
lines.append("These requirements are covered by their module spec but have no separate proposal-response doc in `docs/bozeman/`. That's appropriate when the requirement is straightforward module behavior (e.g., \"System shall support multiple service types per property\") that doesn't need a paragraph-length RFP commitment frame. Promote any of these to a `bz/` doc if the proposal narrative needs more detail than the module spec provides.")
lines.append("")
lines.append("| Req # | Area / Process | Story | Spec |")
lines.append("|---|---|---|---|")
for r in no_bz:
    sp_links = " ".join(sp_link(s) for s in r["sp"]) if r["sp"] else "-"
    lines.append(f"| {r['req']} | {r['area']} / {r['process']} | {truncate(r['story'], 100)} | {sp_links} |")
lines.append("")

lines.append("## 3. Full requirements list (grouped by area / process)")
lines.append("")

groups = defaultdict(list)
order = []
for r in reqs:
    key = (r["area"], r["process"])
    if key not in groups:
        order.append(key)
    groups[key].append(r)

for (a, p) in order:
    items = groups[(a, p)]
    nums = [int(x["req"]) for x in items]
    lines.append(f"### {a} - {p}")
    lines.append(f"*Reqs {min(nums)}-{max(nums)} ({len(items)} requirements)*")
    lines.append("")
    lines.append("| # | Req | Resp | Phase | bz/ | sp/ | plan/ |")
    lines.append("|---|---|---|---|---|---|---|")
    for r in items:
        bz_l = " ".join(bz_link(b) for b in r["bz"]) if r["bz"] else "-"
        sp_l = " ".join(sp_link(s) for s in r["sp"]) if r["sp"] else "-"
        pl_l = " ".join(pl_link(s) for s in r["pl"]) if r["pl"] else "-"
        story = truncate(r['story'], 130)
        lines.append(f"| **{r['req']}** | {story} | {r['response']} | {r['phase']} | {bz_l} | {sp_l} | {pl_l} |")
    lines.append("")

lines.append("## 4. Appendix - full requirement text")
lines.append("")
lines.append("Most requirement stories were truncated in the tables above for readability. Below is the full text of each requirement plus the response comment from the spreadsheet.")
lines.append("")
for r in reqs:
    lines.append(f"### Req {r['req']} - {r['area']} / {r['process']}")
    lines.append("")
    lines.append(f"**Story:** {normalize(r['story'])}")
    lines.append("")
    if r['comment']:
        lines.append(f"**Response comment:** {normalize(r['comment'])}")
        lines.append("")
    lines.append(f"**Response:** {r['response']} | **Module:** {r['module']} | **Phase:** {r['phase']}")
    lines.append("")
    if r['bz'] or r['sp'] or r['pl']:
        bz_l = ", ".join(bz_link(b) for b in r["bz"]) or "-"
        sp_l = ", ".join(sp_link(s) for s in r["sp"]) or "-"
        pl_l = ", ".join(pl_link(s) for s in r["pl"]) or "-"
        lines.append(f"**Coverage:** bz = {bz_l} | sp = {sp_l} | plan = {pl_l}")
        lines.append("")
    lines.append("---")
    lines.append("")

OUTPUT.write_text("\n".join(lines), encoding="utf-8")
print(f"Wrote {len(lines)} lines to {OUTPUT.relative_to(PROJECT_ROOT)}")
print(f"\nTop-level stats:")
print(f"  Total: {len(reqs)}")
print(f"  With bz/: {sum(1 for r in reqs if r['bz'])}")
print(f"  Without bz/: {sum(1 for r in reqs if not r['bz'])}")
print(f"\nbz/ doc usage:")
for b, c in sorted(bz_usage.items(), key=lambda x: -x[1]):
    print(f"  bz/{b} ({BZ_TITLES[b]}): {c}")
