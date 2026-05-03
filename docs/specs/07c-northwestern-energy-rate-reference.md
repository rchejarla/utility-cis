# NorthWestern Energy Montana — Electric Rate Reference

**Purpose:** Forcing-function reference for *electric* rate-model coverage, complementing [`07a-bozeman-rate-reference.md`](./07a-bozeman-rate-reference.md) (water/sewer/stormwater/solid-waste). NorthWestern Energy is the investor-owned utility serving most of Montana for electric and natural gas; the City of Bozeman doesn't run electric service. Together these two references exercise every rate **shape** we expect to support.

**Source:**
- [NorthWestern MT Electric Rates & Tariffs index](https://northwesternenergy.com/billing-payment/rates-tariffs/rates-tariffs-montana/electric-rates-tariffs)
- [Rate Comparison page](https://www.northwesternenergy.com/billing-payment/rates-tariffs/rate-comparison-information)
- [KPAX bill-decode article (April 2025)](https://www.kpax.com/news/montana-news/how-to-decode-your-northwestern-energy-bill)
- Most-recent rate case: PSC order December 2025 implementing 2024/25 rate review

**Captured:** 2026-05-02

> **Status of $-figures below:** NorthWestern publishes tariffs as scanned-image PDFs. The exact per-kWh and per-kW values are not text-extractable through automated fetch. This document captures the **shapes** of every active schedule (which is what the rate-model design needs) and the $-figures we *did* confirm from the bill-decode article and PSC summaries. To populate exact figures, paste from the source PDFs into this doc once during implementation; the shapes won't change.

---

## Tariff portfolio (current schedules)

NorthWestern files **24 active electric schedules** with the Montana PSC. They split into a few categories:

### Customer-facing rate schedules

| Code | Name | Class served | Shape |
|---|---|---|---|
| REDS-1 | Residential Electric Delivery Service | Residential | Customer charge + flat $/kWh delivery |
| RSGTOUD-1 | Residential Smart Grid Time-of-Use Demand (pilot) | Residential opt-in | Customer charge + TOU $/kWh (peak/off-peak) + demand $/kW |
| GSEDS-1 | General Service Electric Delivery Service | Small/medium commercial | Customer charge + demand $/kW + energy $/kWh |
| GSEDS-2 | General Service — Substation/Transmission Level | Large commercial/industrial | Customer charge + demand $/kW (separate substation vs transmission) + energy $/kWh |
| ISEDS-1 | Irrigation Pumping & Sprinkling | Agricultural | Seasonal (irrigation vs non-season): customer charge + per-HP connected charge + energy $/kWh |
| ELDS-1 | Electric Lighting Delivery Service | Street/public lighting | Per-fixture flat $/month by lamp type (no kWh metering) |
| SESS-1 | Standby Electric Service | Customers with on-site generation | Reservation $/kW + as-used $/kWh |

### Supply (generation) — billed alongside delivery

| Code | Name | What it is |
|---|---|---|
| ESS-1 | Electricity Supply Service | Default-supply $/kWh by class (residential / GS / irrigation / lighting). Adjusts quarterly. |
| EESS-1 | Electric Emergency Supply | Emergency / outage backup supply rate |
| EGPS-1 | Electric Green Power Service | Optional 100% renewable supply premium |

### Riders / surcharges / adjustments

| Code | Name | Shape |
|---|---|---|
| EPCC-1 | Annual Power Costs & Credits Adjustment | $/kWh adder/credit, set annually, true-up |
| E-USBC-1 | Universal System Benefits Charge | $/kWh surcharge funding low-income + conservation (Montana statute) |
| CTC-QF-1 | Competitive Transition Charge — Qualifying Facilities | Legacy stranded-cost recovery $/kWh from MPC dissolution |
| WMBA-1 | Wildfire Mitigation Balancing Account | Cost-recovery rider $/kWh |
| WI-1 | Wind Integration | Integration charge for wind-supplied customers |
| PCST-1 | Public Charging Station Tax | EV public charger excise |

### Wholesale / supply-side / structural

QF-1, LTQF-1, LTPP-1, CR-1, CESGTC-1, ECCGP-1, EBS-1 — these govern qualifying-facility power purchases, customer choice, and structural rules. Not retail bill components.

---

## The unbundled-bill structure (key shape)

This is the most important thing to understand about IOU electric vs. muni water/sewer:

**Every electric customer's bill is the sum of TWO rate schedules running side-by-side, plus riders:**

```
Total bill =
    DELIVERY (REDS-1 or GSEDS-1 etc.)
      + customer charge
      + distribution $/kWh
      + transmission $/kWh
      + delivery taxes ($/kWh)
+ SUPPLY (ESS-1)
      + supply $/kWh
      + supply tax ($/kWh)
      + deferred supply rider (true-up)
+ RIDERS that apply to all customers (CTC-QF-1, USBC, WMBA-1, EPCC-1)
+ MISC (BPA Exchange Credit — federal subsidy, applied as negative)
```

A residential bill therefore has **~10 distinct line items**, each a separately-priced and separately-effective-dated component:

1. Service Charge ($4.20/month residential — confirmed from KPAX article)
2. Residential Distribution Delivery ($/kWh, set by REDS-1)
3. Residential Transmission Delivery ($/kWh, set by REDS-1)
4. Residential Electric Delivery Tax ($/kWh, **0.0117650** confirmed)
5. CTC-QF ($/kWh, legacy MPC transition cost)
6. USBC ($/kWh, statutory surcharge)
7. Residential Supply ($/kWh, set by ESS-1)
8. Residential Deferred Supply ($/kWh adder/credit, quarterly true-up rider)
9. Residential Electric Supply Tax ($/kWh)
10. Residential BPA Exchange Credit (negative, subsidy)

Reference data points:
- Typical residential bill at 750 kWh/month: **$123** (NWE rate-comparison page, July 2025)
- October 2025 supply-rate decrease: **−$11.08** (≈9%) for 750 kWh residential
- Residential electric saw a **24% increase** in January 2024 from PSC order

---

## Shape catalog — what each schedule exercises

### REDS-1 (Residential Delivery)
- Flat customer charge ($4.20/month)
- Flat $/kWh delivery (distribution + transmission summed)
- Delivery tax = $/kWh × **0.0117650** (property tax on delivery infra)
- No tier blocks (Montana doesn't use inclining-block residential like California)
- No seasonal variation

### RSGTOUD-1 (Residential TOU + Demand pilot)
- Customer charge
- **TOU energy** — typically peak / off-peak / shoulder windows (NWE pilot specifics not extracted; standard pilot is 4-9pm peak weekdays)
- **Demand charge** — $/kW of highest 60-min average kW in the on-peak window
- Eligibility — residential opt-in, must have AMI meter
- This is the only schedule on the entire NWE menu that puts demand on residential.

### GSEDS-1 (Small/Medium Commercial)
- Customer charge tiered by service capacity
- **Demand charge** — $/kW (non-coincident, single-rate, no TOU split)
- Energy charge $/kWh, often flat
- **Demand ratchet** — typically 75-80% of prior 12-month peak (PSC standard)
- Eligibility — typically up to ~1,000 kW peak demand

### GSEDS-2 (Large Commercial / Industrial)
- Customer charge
- **Demand charge bifurcated** by voltage level:
  - Substation-level service (kV-class delivery)
  - Transmission-level service (sub-transmission delivery)
- Demand ratchet (longer lookback, typically 12-month)
- Energy charge $/kWh, may be TOU
- Eligibility — typically >1,000 kW peak

### ISEDS-1 (Irrigation)
- **Seasonal split** — irrigation season (typically May–October) vs non-season (November–April), with rates differing by season
- Per-connected-HP or per-kW facility charge (paid year-round even off-season)
- Energy charge $/kWh, season-dependent
- Sometimes a minimum bill that matters for off-season

### ELDS-1 (Lighting)
- **Per-fixture flat $/month** keyed by:
  - Lamp type (HPS, LED, MV, etc.)
  - Wattage
  - Mast/pole/luminaire type
- No metering — fixture inventory drives the bill
- Distinct shape entirely: it's a catalog like solid-waste carts, but with a different attribute set

### SESS-1 (Standby)
- Reservation charge $/kW of contracted standby capacity
- Drawn-energy charge $/kWh when standby is actually used
- Two-component shape — neither is a normal energy or demand charge

### ESS-1 (Supply, all classes)
- Per-class flat $/kWh supply rate
- **Quarterly adjustment** — re-priced four times a year based on power-purchase costs
- Separate residential / GS / irrigation / lighting columns, each its own $ figure

### EPCC-1 (Annual Power Costs Adjustment)
- $/kWh **adder or credit** applied to all classes
- Set annually by PSC docket
- Conceptually the same as Bozeman's drought reserve — flat per-unit overlay

### E-USBC-1 (Universal System Benefits Charge)
- $/kWh statutory surcharge (Montana Code 69-8-402)
- Funds low-income energy assistance + conservation programs
- Roughly **2.4% of bill** for residential; collected uniformly

### Net Metering (Rule 16, not a rate schedule)
- Customer-sited renewable generation up to **50 kW**
- Exported energy credited at **retail rate** ($/kWh)
- Monthly netting; year-end true-up for net-positive customers
- A *rate-engine semantics* concern more than a rate-schedule concern: same delivery + supply rates apply, just with a netting rule on the kWh quantity

---

## Confirmed exact figures

These are the only $-precision values pulled cleanly from machine-readable sources:

| Item | Value | Source |
|---|---|---|
| Residential service charge | $4.20/month | KPAX bill-decode article |
| Residential delivery tax | 0.0117650 / kWh | KPAX bill-decode article |
| Typical residential bill (750 kWh) | $123/month | NWE rate-comparison page, Jul 2025 |
| Oct 2025 supply rate change | −$11.08 / month at 750 kWh (≈9%) | NWE bill-decode article |
| Jan 2024 residential rate increase | +24% | PSC order summary |

Everything else listed in the shape catalog is structural; the actual $ values need to be transcribed from the schedule PDFs once.

---

## What this confirms (and challenges) about the v2 component model

Cross-checking NorthWestern's portfolio against [`07b-rate-model-v2-design.md`](./07b-rate-model-v2-design.md):

### Already covered cleanly

- **REDS-1** = `service_charge` + `consumption` (flat) + `surcharge` (delivery tax) — no schema gap.
- **GSEDS-1** = `service_charge` + `consumption (demand-quantity)` + `consumption` — fits IF `quantity_source` is extended to `peak_demand_kw` and the rate engine knows how to compute peak demand from interval reads.
- **ISEDS-1** seasonal split = predicate `{ season: "irrigation" }` toggling between two `consumption` components.
- **EPCC-1, E-USBC-1, CTC-QF-1, WMBA-1** = `surcharge` components with `pricing.type = flat` per kWh. All stack identically.
- **ELDS-1 lighting** = `item_price` catalog (the same kind we use for solid-waste carts), keyed by (lamp_type, wattage, fixture_type).

### Confirmed shape gaps the design needs to address

| Gap | What's missing | Fix |
|---|---|---|
| **Delivery + Supply unbundled** | Today, an SA points to one `rate_schedule_id`. NWE service needs **two** schedules running per SA (delivery + supply), each with its own components. | Either (a) allow N rate schedules per SA, or (b) treat the supply-vs-delivery split as just more components within one schedule — accepting that "the schedule" becomes the union of delivery + supply components. Option (b) is simpler. |
| **Demand quantity source** | `quantity_source` enum doesn't include `peak_demand_kw`. Demand charges need to know the demand interval (15-min vs 60-min) and the measurement window (whole period, on-peak only, etc.). | Add `quantity_source: peak_demand` with a sub-spec: `{ interval_minutes: 15|30|60, window: "all"|"on_peak"|"summer_on_peak", aggregation: "max" }`. |
| **Demand ratchet** | Component has no concept of "billable demand = max(this period, X% of prior 12 months)". | Add ratchet config to the demand quantity spec: `{ ratchet_pct: 75, lookback_months: 12 }`. The bill engine consults a stored peak-demand-history table per SP. |
| **TOU windows** | Predicate DSL has `{ season: "..." }` but no `{ tou_window: "peak" }`. | Add a TOU schedule entity (or simpler: a `tou_calendar_id` ref on the component, with an associated calendar table defining hour ranges per (season, day-type, window)). Then components key on `{ tou_window: "peak" }` and the engine resolves which kWh fell in which window. |
| **Quarterly supply rate adjustment** | ESS-1 changes 4×/year. The current `RateComponent.effective_date` model handles this — every quarter you create a new component version. Just confirms the per-component effective dating was the right call. | None. |
| **Per-fixture lighting** | Lighting needs a fixture inventory model (similar to Container for solid waste, but with attributes: lamp_type, wattage, fixture_type). | New `LightingFixture` table or extend `Container` to be a generic "billable item". The latter avoids a special table per commodity. Bigger discussion. |
| **Net metering** | Quantity becomes `max(0, billed_kwh − exported_kwh)` with annual true-up. Today the engine doesn't have a "net energy" computation. | Add `quantity_source: net_metered` with a sub-spec referencing the export-side meter or a generation_kwh field on the read. |

### Two new component kinds the design needs

| New kind | What it is | Example |
|---|---|---|
| `reservation_charge` | Pay for capacity whether you use it or not | SESS-1 standby: $/kW of contracted standby capacity, paid every month |
| `negative_rider` | Subsidy or credit applied as negative $/kWh, distinct from `credit` (which is `percent_of` another component) | BPA Exchange Credit — federal subsidy applied as a fixed negative $/kWh |

`negative_rider` could fold into `surcharge` with negative pricing — judgment call. `reservation_charge` is genuinely new because the quantity source isn't usage but an assigned-capacity attribute.

---

## Customer-class taxonomy comparison

| Bozeman water | NorthWestern electric |
|---|---|
| Single Family | Residential (REDS) |
| Multi-Family | Residential (REDS) — same schedule |
| Commercial | General Service Small/Medium (GSEDS-1) |
| Industrial | General Service Large (GSEDS-2) — substation or transmission level |
| Government | (no equivalent as a separate class — billed as GSEDS-1 or GSEDS-2 by load) |
| MSU | (similar — large-load institutional, billed under GSEDS-2) |
| n/a | Irrigation (ISEDS-1) — agricultural pumping, seasonal |
| n/a | Lighting (ELDS-1) — municipal/public per-fixture |

So the v2 schema's **`service_class`** ref table needs commodity-specific class lists. A premise's "class for water" (Single Family) is independent of its "class for electric" (Residential). Two different attribute axes.

---

## Forcing-function checklist — additions for electric

A rate model is "good enough for both Bozeman + NorthWestern" iff in addition to the Bozeman list in 07a, it can express:

- [ ] **Two co-applied schedules** per service (delivery + supply) with a single bill rendering
- [ ] **Demand charge** computed from interval reads with configurable interval, window, aggregation
- [ ] **Demand ratchet** with configurable percentage and lookback months
- [ ] **TOU calendar** with seasonal calendar shifts (e.g. summer peak window vs winter peak window)
- [ ] **Per-fixture catalog pricing** for street lighting (no metering)
- [ ] **Reservation charge** for standby service
- [ ] **Quarterly-effective supply rate** without forking the consumption-component sibling
- [ ] **Subsidy as negative line item** (BPA credit) distinguishable from a percentage credit
- [ ] **Net metering** quantity computation (export-aware kWh)
- [ ] **Customer choice / competitive supply** registry — supply schedule is replaceable per customer (CESGTC-1 case)

Of these, **TOU + demand + ratchet** is the most schema-significant. If the design accommodates those cleanly, the rest fall out as smaller deltas.

---

## Implications for product positioning

Positioning this CIS as "for utilities in general" requires the schema to handle **all of the above shapes**. The good news: Bozeman + NorthWestern together cover essentially every shape an investor-owned or municipal utility uses in North America. If the v2 model passes both reference checklists, it can plausibly handle:

- Muni water/sewer/stormwater/solid-waste utilities (Bozeman)
- IOU electric & gas with full TOU/demand/rider stack (NorthWestern)
- Coop electric (similar shapes to NWE, fewer riders)
- Smaller IOU water (subset of Bozeman)

Gaps that remain even after both references:
- **Real-time pricing (RTP)** — hourly market price + adder (industrial customers in deregulated markets like ERCOT). Requires hourly settlement against an external price feed.
- **Critical Peak Pricing (CPP)** — utility-called event days that override normal TOU. Requires an event-day registry.
- **Solar NEM 3.0 / value-of-solar** — net export credited at avoided-cost rate, not retail. Different from simple NEM.
- **Power factor penalty** — kVAR-based adjustment for large industrial.

These are deferrable. None of them are required by Bozeman or NorthWestern, and the component model can absorb them later as additional `kind` values without disturbing existing tariffs.
