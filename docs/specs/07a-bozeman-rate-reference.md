# Bozeman Rate Reference

**Purpose:** Concrete forcing-function dataset for rate-model design. These are the actual published rates from the City of Bozeman, MT, captured for use as the design's "known-correct outputs." Not a tenant configuration; a *target* the data model must be able to express.

**Source:** [bozemanmt.gov utilities services page](https://www.bozemanmt.gov/departments/finance/utilities-services), [solid waste rates](https://www.bozemanmt.gov/departments/transportation-engineering/solid-waste/residential-collections/rates-and-information), [stormwater bill explainer](https://www.bozemanmt.gov/departments/utilities/stormwater/learn-about-my-utility-bill)

**Effective:** 2025-09-15 (all sections below)

**Captured:** 2026-04-30

---

## Customer classes (water + sewer)

Bozeman uses **six classes** that key into different rate rules:

| Class | Notes |
|---|---|
| Single Family | Inclining-block water tiers; sewer WQA |
| Multi-Family | Flat water rate; sewer WQA |
| Government | Flat water rate; metered sewer |
| MSU | Montana State University; flat water; metered sewer |
| Commercial | Flat water rate; metered sewer |
| Industrial | Sewer only at this row in the published table; metered |

Class is independent of meter size. A 1" meter exists in any class. Service charge keys to **meter size**; consumption rate keys to **class**.

---

## Water — service charge (by meter size)

Same for every customer class. Just the cost of having a meter at that size.

| Meter size | $/month |
|---|---|
| 5/8" or 3/4" | 22.31 |
| 1" | 29.56 |
| 1.5" | 46.52 |
| 2" | 67.64 |
| 3" | 116.92 |
| 4" | 187.50 |
| 6" | 349.42 |
| 8" | 552.48 |

---

## Water — consumption (by class)

Unit: **HCF** (hundred cubic feet) ≈ 748 gal.

### Single Family — inclining block

| Bracket | $/HCF |
|---|---|
| Minimum (≤ 2.0 HCF) | 6.62 (flat minimum) |
| 0–6 HCF | 3.31 |
| 6–25 HCF | 4.58 |
| 25–55 HCF | 6.39 |
| 55+ HCF | 9.58 |

The minimum applies as a floor when usage ≤ 2 HCF; above that the inclining tiers apply.

### All other classes — flat per-HCF

| Class | Minimum | $/HCF |
|---|---|---|
| Multi-Family | 6.02 | 3.01 |
| Government | 11.48 | 5.74 |
| MSU | 7.54 | 3.77 |
| Commercial | 6.80 | 3.40 |

Same commodity (water), same tariff sheet — five different rate **shapes** keyed by class. This is the most important thing the schema must accommodate cleanly.

---

## Sewer — service charge (by class)

| Class | $/month |
|---|---|
| Residential | 24.65 |
| Multi-Family | 25.26 |
| Commercial | 25.26 |
| Government | 25.26 |
| MSU | 25.26 |
| Industrial | 49.06 |

---

## Sewer — consumption (by class)

This is where WQA sits. **Same rate sheet, same commodity, different quantity source per class.**

| Class | $/HCF | Quantity source |
|---|---|---|
| Residential | 4.12 | **WQA** (winter quarter average of water consumption) |
| Multi-Family | 4.58 | **WQA** |
| Commercial | 5.13 | metered (real-time water consumption) |
| Government | 4.95 | metered |
| MSU | 5.34 | metered |
| Industrial | 7.79 | metered |

WQA isn't a global feature flag on the sewer schedule — it's a **per-class rule** within one schedule.

---

## Stormwater — non-meter pricing

Two stacked components per service:

| Component | Rate | Basis |
|---|---|---|
| Flat | $4.81 / month | per water meter |
| Variable | $3.99 / ERU | 1 ERU = 2,700 sq ft impervious surface |
| Credit | −45% of variable | only if property has approved on-site infrastructure |

**Examples from the city:**

| Property | Calculation | Total |
|---|---|---|
| Single-family, no infra | $4.81 + $3.99 = | $8.80 |
| Single-family, with infra | $4.81 + $3.99 − $1.80 = | $7.00 |
| Commercial, 16,200 sqft, 6 ERU, no infra | $4.81 + $23.94 = | $28.75 |
| Commercial, 16,200 sqft, 6 ERU, with infra | $4.81 + $23.94 − $10.80 = | $17.95 |

No meter at all; pure premise-attribute pricing (impervious area). The system needs to store ERU count or impervious sq ft on the premise.

---

## Solid Waste — product catalog (per cart)

| Size | Garbage | Recycling | Organics |
|---|---|---|---|
| 35 gal | — | — | 12.00 |
| 35/45 gal weekly | 18.96 | — | — |
| 45 gal monthly | 14.11 | — | — |
| 65 gal | 27.24 | 12.96 | — |
| 95 gal | — | — | 12.00 |
| 100 gal | 34.91 | 12.96 | — |
| 220 gal | 58.30 | — | — |
| 300 gal | 73.09 | 20.17 | — |
| 450 gal | 105.30 | — | — |

Notes:
- **Frequency is a pricing dimension** (45-gal weekly = 18.96; 45-gal monthly = 14.11)
- **One-time tote delivery fee:** $7 (waived for organics)
- **Tenant deposits** (refundable, not a charge): vary by size — separate concept from the rate
- A property can have multiple totes (garbage + recycling + organics) — each priced independently and stacked on the bill

This isn't a rate engine — it's a **lookup table on (commodity, size, frequency)**.

---

## Drought surcharge — conditional overlay

The City declares a drought stage (1–4). Each stage applies a percentage adder to specific water consumption tiers, plus a flat per-HCF reserve charge.

| Component | Behavior |
|---|---|
| Drought stage surcharge | Stage 1: up to 24.9% / Stage 4: up to 200%. Percentage varies by class and tier. |
| Drought Reserve | $0.11 / HCF — flat, applies to all classes once any stage is declared |

When no stage is active, neither charge applies. When active, both stack on top of base water consumption charges. The full per-stage / per-tier table wasn't published on the public page; a real implementation needs the full ordinance.

This is the cleanest example of a **stackable overlay** in the dataset:
- Conditional (depends on city-wide flag)
- Stacks on top of an existing component (water consumption)
- Has multiple shapes (percentage + flat per-unit) within the same overlay

---

## Things conspicuously NOT on the public rate sheet

These exist in real Bozeman billing but aren't published as web tables. Real implementation needs the actual ordinance:

- **Per-stage drought surcharge percentages** (only ranges shown above)
- **Account-level rate overrides** (Solid Waste Req 58: authorized rate overrides with audit)
- **Late fees / penalty rates** (handled in delinquency module)
- **Special assessment rates** (separate module, separate rate concept)
- **Connection / impact fees** (one-time, not utility billing)
- **Reconnection / shut-off / NSF fees** (event-based fees module)
- **Backflow / reverse-flow rules** (Bozeman Req 101 — likely a consumption adjustment, not a rate)

---

## Forcing-function checklist for schema design

A rate model is "good enough for Bozeman" iff it can express, without code branches:

- [ ] Water consumption rate that's **inclining tiers for one class, flat per-HCF for another**, on the same schedule
- [ ] **Service charge keyed by meter size**, distinct from consumption charge keyed by class
- [ ] Sewer schedule with **WQA quantity source for some classes, metered for others**, in a single schedule
- [ ] Stormwater rate with **no meter**, keyed to a premise attribute (impervious area / ERU count) plus a per-account credit toggle
- [ ] Solid waste **catalog lookup** by (commodity, size, frequency) with multiple cart instances per property
- [ ] **One-time fee** ($7 cart delivery) attached to a service event, not a recurring rate component
- [ ] **Drought surcharge overlay** that's conditional, stacks on top of consumption, and has both percentage and flat-per-unit shapes
- [ ] **Effective-date** every component independently (a tax change shouldn't force a new water schedule)
- [ ] **Rebill on read correction** — when a winter-window read is corrected, recompute WQA for affected customers and trigger sewer rebills

If a proposed schema can't model any one of these without a code-side special case, the schema isn't ready.
