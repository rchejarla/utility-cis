"use client";

import { useEffect, useState } from "react";
import { EntityFormPage } from "@/components/ui/entity-form-page";
import { apiClient } from "@/lib/api-client";

/**
 * /read-routes/new — naming a route so its walk can be built.
 *
 * **Three fields, because a route is three facts and the rest is the
 * walk.** A code somebody says out loud, a name somebody recognises, and
 * the billing cycle whose window its reads are due in — that last one is
 * NOT NULL in the schema for the reason §5.1 gives: a route with no cycle
 * has no day its reads are due by, so there is nothing for progress to
 * measure against and nothing for the sheet to print as a due date. The
 * cycles are fetched rather than typed, since they are the tenant's own.
 *
 * **`origin` is deliberately not offered.** A route created here is
 * `LOCAL` by definition — somebody is about to add stops to it. An
 * `EXTERNAL` route is created by the importer, the first time a vendor's
 * read names a code nobody has seen (§5.4), and it exists so that read
 * has something to point at. Offering the choice would let somebody
 * hand-make a row claiming a vendor owns an itinerary no reads are coming
 * for — a route with no stops, no sheet and no entry, and no way back
 * except the claim-as-local operation that does not exist yet.
 * `readRouteInputSchema` defaults it, so the body omits it.
 *
 * `active` is not offered either: a route is in use the moment it is
 * made, and retiring one is a later decision taken on its own page.
 *
 * This page was missing until 2026-11-18, and the list had been shipping
 * an "Add Read Route" button and an empty-state call to action pointing
 * at it — so the one action offered to a tenant with no routes was a 404,
 * and `POST /api/v1/read-routes` had no caller. The e2e stream found it
 * by having to create its fixture route through the API.
 */

interface ReadRouteForm extends Record<string, unknown> {
  code: string;
  name: string;
  billingCycleId: string;
}

interface Cycle {
  id: string;
  cycleCode: string;
  name: string;
}

export default function NewReadRoutePage() {
  /*
   * Fetched here and handed to the form as a **static** option list, so
   * the field renders a plain `<select>`.
   *
   * `EntityFormPage`'s dynamic-options spec would be less code, but it
   * delegates to `SearchableEntitySelect` — a typeahead that queries on
   * demand, and whose own comment says it exists so a 50k-row endpoint
   * does not hang the page on open. A utility has a handful of billing
   * cycles, nobody picking one knows its code by heart, and making them
   * type to discover three options is worse than showing three options.
   * The reading-progress screen and this feature's own list filter both
   * treat cycles the same way.
   */
  const [cycles, setCycles] = useState<Cycle[] | null>(null);

  useEffect(() => {
    apiClient
      .get<{ data: Cycle[] } | Cycle[]>("/api/v1/billing-cycles")
      .then((res) => setCycles(Array.isArray(res) ? res : (res.data ?? [])))
      .catch(() => setCycles([]));
  }, []);

  /*
   * Says which of three states it is in, rather than rendering an empty
   * control for all of them: still loading, nothing to pick, or a list.
   * An empty `<select>` with no placeholder reads as a broken control,
   * which is the fault the progress screen shipped and had fixed.
   */
  const cycleOption =
    cycles === null
      ? "Loading cycles…"
      : cycles.length === 0
        ? "No billing cycles — create one first"
        : "Choose a cycle…";

  return (
    <EntityFormPage<ReadRouteForm>
      title="New Read Route"
      subtitle="Name a walk, then build it stop by stop"
      module="meter_reads"
      endpoint="/api/v1/read-routes"
      returnTo="/read-routes"
      submitLabel="Create Read Route"
      maxWidth="560px"
      initialValues={{ code: "", name: "", billingCycleId: "" }}
      fields={[
        {
          key: "code",
          label: "Code",
          type: "text",
          required: true,
          placeholder: "W-04",
          hint: "Unique per utility. This is what a reader says out loud, and what a vendor's file would name.",
        },
        {
          key: "name",
          label: "Name",
          type: "text",
          required: true,
          placeholder: "North Willson",
        },
        {
          key: "billingCycleId",
          label: "Billing Cycle",
          type: "select",
          required: true,
          emptyOption: cycleOption,
          options: (cycles ?? []).map((c) => ({
            value: c.id,
            label: `${c.cycleCode} — ${c.name}`,
          })),
          hint: "Gives the route's reads a day they are due by. Stops whose account bills on another cycle still print, and the route page lists them.",
        },
      ]}
      /*
       * Only the three. `origin` and `active` are left to the validator's
       * defaults rather than sent as values this form never asked about.
       */
      toRequestBody={(values) => ({
        code: values.code.trim(),
        name: values.name.trim(),
        billingCycleId: values.billingCycleId,
      })}
      /*
       * Straight to the new route, not back to the list: the next thing
       * anybody does with a route they have just named is add its stops,
       * and that control is on its own page.
       */
      onSuccess={(response) => {
        const id = (response as { id?: string } | null)?.id;
        return id ? `/read-routes/${id}` : "/read-routes";
      }}
    />
  );
}
