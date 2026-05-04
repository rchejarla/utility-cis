import { prisma } from "../lib/prisma.js";
import type {
  CustomerGraphDTO,
  GraphEdge,
  GraphNode,
} from "@utility-cis/shared";

const NODE_CAP = 200;

/**
 * Build a CustomerGraphDTO for the /customers/:id/graph view.
 *
 * The graph models the customer-service domain as a tree-with-cross-
 * links, NOT a flat tree. The dominant spanning tree is:
 *
 *   Customer
 *   ├── Premise(s)                   (primary child — where service happens)
 *   │     ├── Agreement(s)           (service contracted here)
 *   │     ├── Meter(s)               (devices installed here)
 *   │     └── Service Request(s)     (issues filed about this location)
 *   └── Account(s)                   (peer of Premise — billing envelope)
 *
 * Plus secondary cross-link edges that record the billing +
 * measurement relationships without duplicating nodes:
 *   Agreement --billed_by-->  Account
 *   Agreement --uses-->       Meter
 *   Service Request --on-->   Account
 *
 * The UI renders primary edges solid and secondary edges dashed so
 * the spanning tree stays visible while the cross-cutting
 * relationships are legible.
 */
export async function buildCustomerGraph(
  utilityId: string,
  customerId: string,
): Promise<CustomerGraphDTO> {
  const customer = await prisma.customer.findFirstOrThrow({
    where: { id: customerId, utilityId },
    include: {
      ownedPremises: true,
      accounts: {
        include: {
          serviceAgreements: {
            include: {
              servicePoints: {
                where: { endDate: null },
                orderBy: { startDate: "asc" },
                include: {
                  premise: true,
                  meters: {
                    where: { removedDate: null },
                    include: { meter: true },
                  },
                },
              },
              commodity: { select: { id: true, code: true, name: true } },
            },
            orderBy: { startDate: "asc" },
          },
          serviceRequests: {
            orderBy: { createdAt: "desc" },
            take: 50,
          },
        },
      },
    },
  });

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  const customerName =
    customer.customerType === "ORGANIZATION"
      ? customer.organizationName ?? "Organization"
      : `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim() || "Customer";
  const customerNodeId = `customer:${customer.id}`;

  // ─── Customer node ───
  nodes.push({
    id: customerNodeId,
    type: "customer",
    label: customerName,
    subtext: customer.customerType,
    data: {
      id: customer.id,
      customerType: customer.customerType,
      status: customer.status,
      email: customer.email,
      phone: customer.phone,
    },
    validFrom: customer.createdAt.toISOString(),
    validTo: null,
  });

  // ─── Gather every premise that will appear ───
  // The graph shows every premise the customer touches — both premises
  // the customer owns AND premises where the customer has service
  // agreements, even if the customer doesn't own them.
  const premiseById = new Map<
    string,
    {
      id: string;
      addressLine1: string;
      city: string;
      state: string;
      zip: string;
      premiseType: string;
      status: string;
      createdAt: Date;
    }
  >();
  for (const p of customer.ownedPremises) premiseById.set(p.id, p);
  for (const acc of customer.accounts) {
    for (const ag of acc.serviceAgreements) {
      const sp = ag.servicePoints[0];
      if (sp?.premise && !premiseById.has(sp.premise.id)) {
        premiseById.set(sp.premise.id, sp.premise);
      }
    }
  }

  // Emit premise nodes + Customer → Premise edges (owns_premise).
  for (const p of premiseById.values()) {
    const nid = `premise:${p.id}`;
    nodes.push({
      id: nid,
      type: "premise",
      label: p.addressLine1,
      subtext: `${p.city}, ${p.state} ${p.zip}`,
      data: {
        id: p.id,
        addressLine1: p.addressLine1,
        city: p.city,
        state: p.state,
        zip: p.zip,
        premiseType: p.premiseType,
        status: p.status,
      },
      validFrom: p.createdAt.toISOString(),
      validTo: null,
    });
    edges.push({
      id: `edge:customer-owns:${p.id}`,
      from: customerNodeId,
      to: nid,
      kind: "owns_premise",
      validFrom: p.createdAt.toISOString(),
      validTo: null,
    });
  }

  // Which premise does each meter live at? Meters are attached to
  // agreements via the junction, and each agreement has a premise —
  // use that to route meters under the correct premise in the tree.
  const meterPremiseIdByMeterId = new Map<string, string>();

  // ─── Accounts (peer of premise under customer) ───
  for (const acc of customer.accounts) {
    const accNodeId = `account:${acc.id}`;
    nodes.push({
      id: accNodeId,
      type: "account",
      label: acc.accountNumber,
      subtext: `${acc.accountType} · ${acc.status}`,
      data: {
        id: acc.id,
        accountNumber: acc.accountNumber,
        accountType: acc.accountType,
        status: acc.status,
        balance: acc.balance.toString(),
      },
      validFrom: acc.createdAt.toISOString(),
      validTo: acc.closedAt ? acc.closedAt.toISOString() : null,
    });
    edges.push({
      id: `edge:customer-owns-account:${acc.id}`,
      from: customerNodeId,
      to: accNodeId,
      kind: "owns_account",
      validFrom: acc.createdAt.toISOString(),
      validTo: acc.closedAt ? acc.closedAt.toISOString() : null,
    });

    // ─── Agreements (child of their premise; cross-linked to account) ───
    for (const ag of acc.serviceAgreements) {
      const agNodeId = `agreement:${ag.id}`;

      nodes.push({
        id: agNodeId,
        type: "agreement",
        label: ag.agreementNumber,
        subtext: ag.commodity?.name ?? "",
        data: {
          id: ag.id,
          agreementNumber: ag.agreementNumber,
          status: ag.status,
          commodity: ag.commodity,
          // Keep the premise reference on the agreement node data even
          // though we don't draw a premise→agreement edge any more.
          // The web layout sorts accounts by the premise their
          // agreements serve; without this, accounts with flat-rate
          // (meterless) agreements would have nowhere to look.
          premiseId: ag.servicePoints[0]?.premise?.id ?? null,
          startDate: ag.startDate.toISOString(),
          endDate: ag.endDate ? ag.endDate.toISOString() : null,
        },
        validFrom: ag.startDate.toISOString(),
        validTo: ag.endDate ? ag.endDate.toISOString() : null,
      });

      // Primary: the agreement sits under its account in the billing
      // column (row 2 col 3 under col 4). We do NOT emit a separate
      // premise → agreement edge — the premise↔agreement relationship
      // is already expressed transitively through the meter cross-link
      // (premise has meter, meter is used by agreement), and drawing
      // it explicitly would add a long line across the row that adds
      // no information.
      edges.push({
        id: `edge:agreement-account:${ag.id}`,
        from: agNodeId,
        to: accNodeId,
        kind: "agreement_billed_by_account",
        validFrom: ag.startDate.toISOString(),
        validTo: ag.endDate ? ag.endDate.toISOString() : null,
      });

      // Meters for this agreement — route each meter under its
      // SP's premise so the meter becomes a child of the
      // premise in the spanning tree. The agreement-uses-meter edge
      // is emitted as a secondary cross-link.
      for (const sp of ag.servicePoints) {
        for (const spm of sp.meters) {
          const m = spm.meter;
          if (sp.premise && !meterPremiseIdByMeterId.has(m.id)) {
            meterPremiseIdByMeterId.set(m.id, sp.premise.id);
          }
        }
      }
    }

    // ─── Service Requests (child of their premise; cross-link to account) ───
    for (const sr of acc.serviceRequests) {
      const srNodeId = `service_request:${sr.id}`;
      nodes.push({
        id: srNodeId,
        type: "service_request",
        label: sr.requestNumber,
        subtext: `${sr.requestType} · ${sr.status}`,
        data: {
          id: sr.id,
          requestNumber: sr.requestNumber,
          requestType: sr.requestType,
          priority: sr.priority,
          status: sr.status,
          slaDueAt: sr.slaDueAt ? sr.slaDueAt.toISOString() : null,
          slaBreached: sr.slaBreached,
          description: sr.description,
        },
        validFrom: sr.createdAt.toISOString(),
        validTo: sr.completedAt
          ? sr.completedAt.toISOString()
          : sr.cancelledAt
            ? sr.cancelledAt.toISOString()
            : null,
      });

      // Primary: the SR lives under its premise when one is set.
      // Fallback: if no premise, hang it off the account as a child.
      const srPremiseNodeId = sr.premiseId ? `premise:${sr.premiseId}` : null;
      if (srPremiseNodeId && premiseById.has(sr.premiseId!)) {
        edges.push({
          id: `edge:premise-sr:${sr.id}`,
          from: srPremiseNodeId,
          to: srNodeId,
          kind: "premise_has_service_request",
          validFrom: sr.createdAt.toISOString(),
          validTo: sr.completedAt
            ? sr.completedAt.toISOString()
            : sr.cancelledAt
              ? sr.cancelledAt.toISOString()
              : null,
        });
      }

      // Secondary cross-link: the SR's billing-side account.
      edges.push({
        id: `edge:account-sr:${sr.id}`,
        from: srNodeId,
        to: accNodeId,
        kind: "service_request_on_account",
        validFrom: sr.createdAt.toISOString(),
        validTo: sr.completedAt
          ? sr.completedAt.toISOString()
          : sr.cancelledAt
            ? sr.cancelledAt.toISOString()
            : null,
      });
    }
  }

  // ─── Meter nodes (child of their premise; cross-link to agreement) ───
  // Emit once per meter regardless of how many agreements share it.
  const meterNodesEmitted = new Set<string>();
  for (const acc of customer.accounts) {
    for (const ag of acc.serviceAgreements) {
      const agNodeId = `agreement:${ag.id}`;
      const meterPairsForAg: { id: string; meterNumber: string; meterType: string; status: string; installDate: Date; removalDate: Date | null }[] = [];
      for (const sp of ag.servicePoints) {
        for (const spm of sp.meters) meterPairsForAg.push(spm.meter);
      }
      for (const m of meterPairsForAg) {
        const mNodeId = `meter:${m.id}`;
        if (!meterNodesEmitted.has(mNodeId)) {
          meterNodesEmitted.add(mNodeId);
          nodes.push({
            id: mNodeId,
            type: "meter",
            label: m.meterNumber,
            subtext: m.meterType,
            data: {
              id: m.id,
              meterNumber: m.meterNumber,
              meterType: m.meterType,
              status: m.status,
              installDate: m.installDate.toISOString(),
            },
            validFrom: m.installDate.toISOString(),
            validTo: m.removalDate ? m.removalDate.toISOString() : null,
          });

          // Primary: meter lives under its premise.
          const meterPremiseId = meterPremiseIdByMeterId.get(m.id);
          if (meterPremiseId && premiseById.has(meterPremiseId)) {
            edges.push({
              id: `edge:premise-meter:${m.id}`,
              from: `premise:${meterPremiseId}`,
              to: mNodeId,
              kind: "premise_has_meter",
              validFrom: m.installDate.toISOString(),
              validTo: m.removalDate ? m.removalDate.toISOString() : null,
            });
          }
        }

        // Secondary cross-link: agreement uses meter. Emitted once per
        // (agreement, meter) pair.
        edges.push({
          id: `edge:agreement-uses-meter:${ag.id}:${m.id}`,
          from: agNodeId,
          to: mNodeId,
          kind: "agreement_uses_meter",
          validFrom: ag.startDate.toISOString(),
          validTo: ag.endDate ? ag.endDate.toISOString() : null,
        });
      }
    }
  }

  // Truncate if the graph grew past the node cap (industrial
  // customers). Dropped from the tail; primary-tree nodes are
  // emitted first so they survive truncation preferentially.
  const truncated = nodes.length > NODE_CAP;
  const finalNodes = truncated ? nodes.slice(0, NODE_CAP) : nodes;
  const keptIds = new Set(finalNodes.map((n) => n.id));
  const finalEdges = edges.filter((e) => keptIds.has(e.from) && keptIds.has(e.to));

  return {
    customerId: customer.id,
    nodes: finalNodes,
    edges: finalEdges,
    truncated,
  };
}
