# Maps each Bozeman functional requirement to one of this app's modules
# (per CLAUDE.md docs/specs/ list). Updates column 6 ("Module / System")
# in the Functional Requirements sheet.
#
# Row numbers below are spreadsheet rows (1-based). Data starts at
# row 4 (req#1) and runs to row 205 (req#202). Each entry was
# classified by reading the User Story Requirement column.

# Resolved from this script's own location so the repo can live anywhere.
$repoRoot = Split-Path -Parent $PSScriptRoot
$path = Join-Path $repoRoot "bozeman-functional-reqs.xlsx"

$assignments = @{
  # Customer - Property File (req#1-41 → rows 4-44)
  4 = "Premise Management"          # GIS authoritative for property data
  5 = "Premise Management"          # configurable GIS sync schedules
  6 = "Premise Management"          # store GIS Parcel ID, Premise ID
  7 = "Premise Management"          # display GIS-sourced addresses with history
  8 = "Account Management"          # effective-dated account-to-property
  9 = "Rate Management"             # GIS attributes determine default rates
  10 = "Premise Management"         # restrict overrides of GIS attributes
  11 = "Service Agreement"          # multiple service types at locations
  12 = "Account Management"         # multiple accounts per GIS property
  13 = "Account Management"         # single account, multiple GIS properties
  14 = "Custom Fields"              # user-defined required fields in customer file
  15 = "Customer Management"        # multiple customer types
  16 = "Account Management"         # multiple contacts per account, configurable roles
  17 = "Account Management"         # landlord/tenant — bill payer ≠ owner
  18 = "Account Management"         # transfer of service when account closed
  19 = "Customer Management"        # duplicate customer detection
  20 = "Account Management"         # alternate bill-to addresses
  21 = "Account Management"         # international billing addresses
  22 = "Account Management"         # deposits required for renters
  23 = "Payments & Collections"     # refund deposits at closure
  24 = "Payments & Collections"     # apply deposit to unpaid charges
  25 = "Account Management"         # account status values
  26 = "Delinquency"                # flag delinquent accounts during lookup
  27 = "Customer Management"        # search by any field
  28 = "Reporting & Audit"          # retain GIS property records for audit
  29 = "Account Management"         # consolidated account history view
  30 = "Notifications"              # automated email/SMS/postal notifications
  31 = "Notifications"              # configurable notification triggers
  32 = "Notifications"              # communication templates
  33 = "Notifications"              # bulk/mass communications
  34 = "Notifications"              # opt-in/opt-out SMS
  35 = "Notifications"              # communication preferences
  36 = "Notifications"              # communication history
  37 = "Customer Portal"            # secure web portal
  38 = "Customer Portal"            # customers view account/property
  39 = "Customer Portal"            # customers update contact info
  40 = "Customer Portal"            # manage communication preferences
  41 = "Customer Portal"            # self-service auth + role-based access
  42 = "Customer Portal"            # configurable identity verification
  43 = "Customer Portal"            # recurring payment enrollment
  44 = "Customer Portal"            # configurable billing/payment alerts

  # Solid Waste (req#42-59 → rows 45-62) — all map to the Solid Waste module
  45 = "Solid Waste"; 46 = "Solid Waste"; 47 = "Solid Waste"; 48 = "Solid Waste"
  49 = "Solid Waste"; 50 = "Solid Waste"; 51 = "Solid Waste"; 52 = "Solid Waste"
  53 = "Solid Waste"; 54 = "Solid Waste"; 55 = "Solid Waste"; 56 = "Solid Waste"
  57 = "Solid Waste"; 58 = "Solid Waste"; 59 = "Solid Waste"; 60 = "Solid Waste"
  61 = "Solid Waste"; 62 = "Solid Waste"

  # Water/Wastewater/Stormwater (req#60-127 → rows 63-130)
  63 = "Service Agreement"          # separate water/wastewater/stormwater per property
  64 = "Billing"                    # multiple services on consolidated bill
  65 = "Service Agreement"          # effective-dated water enrollment
  66 = "Rate Management"            # regulatory fees and surcharges
  67 = "Rate Management"            # taxes and franchise fees
  68 = "Meter Reading"              # meter multiplier in consumption calc
  69 = "Rate Management"            # multiple water rate structures
  70 = "Rate Management"            # different rates by customer type
  71 = "Rate Management"            # future-dated rate ordinances
  72 = "Rate Management"            # wastewater = 100% water except WQA
  73 = "Rate Management"            # caps/min/max for wastewater incl WQA
  74 = "Rate Management"            # configurable WQA calculations
  75 = "Rate Management"            # winter averaging for wastewater
  76 = "Rate Management"            # exclude irrigation from wastewater
  77 = "Rate Management"            # minimum bills regardless of usage
  78 = "Meter Reading"              # meter reading authoritative
  79 = "Meter Reading"              # integrate via APIs/files
  80 = "Import Infrastructure"      # incremental and full read imports
  81 = "Meter Reading"              # cycle scheduling, route grouping
  82 = "Meter Reading"              # unique read identifiers, prevent dupes
  83 = "Meter Reading"              # associate reads to meters
  84 = "Meter Management"           # multi-register handling
  85 = "Meter Reading"              # estimated vs actual labels
  86 = "Meter Reading"              # ingest interval data
  87 = "Meter Management"           # ingest meter events
  88 = "Meter Management"           # events trigger notifications/holds
  89 = "Meter Reading"              # freeze validated reads
  90 = "Meter Reading"              # before/after for corrected reads
  91 = "Reporting & Audit"          # audit trail of reads/edits
  92 = "Meter Reading"              # manual entry/correction
  93 = "Meter Management"           # new/replacement meters mid-cycle
  94 = "Meter Management"           # replaced meters mid-cycle, both reads
  95 = "Meter Reading"              # mid-cycle final reads
  96 = "Meter Reading"              # validate with thresholds
  97 = "Meter Reading"              # flag abnormal reads
  98 = "Meter Reading"              # flag invalid reads
  99 = "Meter Reading"              # estimation/substitution rules
  100 = "Import Infrastructure"     # error handling for failed imports
  101 = "Meter Reading"             # backflow/reverse flow handling
  102 = "Billing"                   # configurable leak adjustment
  103 = "Reporting & Audit"         # exception reports for staff
  104 = "Billing"                   # aggregate to billable consumption
  105 = "Billing"                   # partial billing period usage
  106 = "Billing"                   # reprocessing/rebilling on corrections
  107 = "Billing"                   # reconciliation reads to billed
  108 = "Reporting & Audit"         # detailed calculation audit trails
  109 = "Meter Management"          # sync meter inventory with mgmt system
  110 = "Import Infrastructure"     # bulk meter inventory imports
  111 = "Meter Management"          # scheduled and on-demand inventory
  112 = "Meter Management"          # comprehensive asset registry
  113 = "Meter Management"          # chain-of-custody history
  114 = "Meter Management"          # effective-dated associations
  115 = "Meter Management"          # master/sub-meter configurations
  116 = "Meter Management"          # multiple meter types
  117 = "Meter Management"          # manufacturer/model/size/serial
  118 = "Meter Management"          # location tracking (warehouse/installed/retired)
  119 = "Meter Management"          # install/removal events with continuity
  120 = "Meter Management"          # meter rollovers, register changes
  121 = "Meter Management"          # testing/certification/failure
  122 = "Meter Management"          # inventory reconciliation
  123 = "Meter Management"          # inventory errors to exception queues
  124 = "Reporting & Audit"         # asset status, lifecycle, testing reports
  125 = "Meter Management"          # flag end-of-life meters
  126 = "Meter Management"          # meter location in multi-unit building
  127 = "Delinquency"               # configurable shut-off eligibility rules
  128 = "Delinquency"               # multiple notice levels with thresholds
  129 = "Delinquency"               # automatic identify shut-off-eligible
  130 = "Reporting & Audit"         # configurable reporting module

  # Billing (req#128-164 → rows 131-167)
  131 = "Customer Portal"           # display current/historical bills
  132 = "Customer Portal"           # consolidated bill viewing
  133 = "Billing"                   # generate PDF bills, retain images
  134 = "Billing"                   # printed bill generation, third-party export
  135 = "Billing"                   # paperless billing enrollment
  136 = "Billing"                   # bill reprints, version tracking
  137 = "Billing"                   # final bill at account closure
  138 = "Billing"                   # multiple concurrent billing cycles
  139 = "Billing"                   # bill holds
  140 = "Billing"                   # bill message management
  141 = "Billing"                   # prorate tier thresholds
  142 = "Billing"                   # itemize charges
  143 = "Billing"                   # validate against rates
  144 = "Billing"                   # reconciliation water/wastewater
  145 = "Billing"                   # rebill on read corrections
  146 = "Billing"                   # ad hoc/special fees
  147 = "Billing"                   # fees on customer subsets
  148 = "Delinquency"               # auto-apply late fees
  149 = "Payments & Collections"    # write-off workflow
  150 = "Payments & Collections"    # payment plans
  151 = "Payments & Collections"    # payment plan notifications
  152 = "Reporting & Audit"         # aging dashboard
  153 = "Reporting & Audit"         # aging dashboard real-time
  154 = "Delinquency"               # water shut-off rules (duplicate of 127)
  155 = "Customer Portal"           # multiple accounts under single login
  156 = "Account Management"        # third-party payer access
  157 = "Payments & Collections"    # payment allocation rules
  158 = "Payments & Collections"    # partial/over/advance payments
  159 = "Customer Portal"           # view payment history
  160 = "Payments & Collections"    # multiple payment methods
  161 = "Payments & Collections"    # PCI compliance
  162 = "Payments & Collections"    # real-time and batch posting
  163 = "Payments & Collections"    # payment confirmations
  164 = "Reporting & Audit"         # daily/period-end reconciliation reports
  165 = "Payments & Collections"    # POS integration
  166 = "Payments & Collections"    # automatic payment reversal
  167 = "Payments & Collections"    # real-time payment integration

  # Special Assessments (req#165-179 → rows 168-182) — all map to module
  168 = "Special Assessments"; 169 = "Special Assessments"; 170 = "Special Assessments"
  171 = "Special Assessments"; 172 = "Special Assessments"; 173 = "Special Assessments"
  174 = "Special Assessments"; 175 = "Special Assessments"; 176 = "Special Assessments"
  177 = "Special Assessments"; 178 = "Special Assessments"; 179 = "Special Assessments"
  180 = "Special Assessments"; 181 = "Special Assessments"; 182 = "Special Assessments"

  # Service Requests (req#180-202 → rows 183-205)
  183 = "Service Requests"          # intake via CSR/portal/API
  184 = "Service Requests"          # associate to GIS properties
  185 = "Service Requests"          # configurable types/subtypes
  186 = "Service Requests"          # scheduled and unscheduled
  187 = "Service Requests"          # attachments
  188 = "Service Requests"          # priority/severity
  189 = "Service Requests"          # assignment to users/groups
  190 = "Service Requests"          # SLAs by type
  191 = "Service Requests"          # escalation workflows
  192 = "Service Requests"          # route SW SRs to RAMS
  193 = "Service Requests"          # route water SRs to work system
  194 = "Service Requests"          # bi-directional status updates
  195 = "Service Requests"          # link SRs to single work order
  196 = "Service Requests"          # distinguish completed/canceled/incomplete
  197 = "Service Requests"          # identify repeat SRs
  198 = "Service Requests"          # dispute handling for SR charges
  199 = "Service Requests"          # full audit trail for SRs
  200 = "Reporting & Audit"         # report on volumes, SLAs, billing outcomes
  201 = "Delinquency"               # internal SRs for shut-offs at delinquency
  202 = "Service Requests"          # SRs for turn-back-on after shut-off paid
  203 = "Service Requests"          # generate charges/credits on completion
  204 = "Service Requests"          # authorized fee waivers with audit
  205 = "Notifications"             # automated SR notifications
}

$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
$wb = $excel.Workbooks.Open($path)
$ws = $wb.Sheets.Item("Functional Requirements")

$updated = 0
foreach ($row in $assignments.Keys | Sort-Object) {
  $ws.Cells.Item($row, 6).Value2 = $assignments[$row]
  $updated++
}

# Sanity check: any data row 4-205 not covered?
$missing = 0
for ($r = 4; $r -le 205; $r++) {
  if (-not $assignments.ContainsKey($r)) {
    $reqNum = $ws.Cells.Item($r, 1).Value2
    if ($reqNum) {
      Write-Output ("UNCLASSIFIED row=$r req=$reqNum")
      $missing++
    }
  }
}

$wb.Save()
$wb.Close($true)
$excel.Quit()
[System.Runtime.Interopservices.Marshal]::ReleaseComObject($excel) | Out-Null
Write-Output ("Updated $updated rows, $missing unclassified")
