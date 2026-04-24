import { prisma } from "../lib/prisma.js";
import type {
  CustomerGraphDTO,
  GraphEdge,
  GraphNode,
  TimelineEvent,
} from "@utility-cis/shared";

const NODE_CAP = 200;

/**
 * Build a CustomerGraphDTO for the /customers/:id/graph view.
 *
 * One tenant-scoped read pulls the customer with all downstream
 * relationships: owned premises, accounts (with contacts, agreements,
 * service requests) and the meters those agreements touch through
 * the service_agreement_meter junction. The shape is then flattened
 * into nodes + edges + a chronological event list. See
 * docs/superpowers/specs/2026-04-24-customer-graph-view.md for the
 * UX this drives.
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
              premise: true,
              commodity: { select: { id: true, code: true, name: true } },
              rateSchedule: { select: { id: true, code: true, name: true } },
              meters: {
                include: {
                  meter: true,
                },
              },
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
  const events: TimelineEvent[] = [];
  const meterNodeIds = new Set<string>();
  const premiseNodeIds = new Set<string>();

  const customerName =
    customer.customerType === "ORGANIZATION"
      ? customer.organizationName ?? "Organization"
      : `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim() || "Customer";

  // Customer node — always the center.
  nodes.push({
    id: `customer:${customer.id}`,
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
  events.push({
    id: `evt:customer-created:${customer.id}`,
    occurredAt: customer.createdAt.toISOString(),
    kind: "customer.created",
    label: `Customer record created`,
    relatedNodeIds: [`customer:${customer.id}`],
  });

  // Compute the set of premise IDs that will be reached through
  // an agreement (at_premise). For those, we skip the redundant
  // customer -> premise (owns_premise) edge: residential customers
  // typically own the premise they have service at, and rendering
  // both as parallel lines to the same node is visual noise. The
  // owns_premise edge is only meaningful when the customer owns a
  // premise with NO agreement (e.g. a landlord's rental property).
  const agreementLinkedPremiseIds = new Set<string>();
  for (const acc of customer.accounts) {
    for (const ag of acc.serviceAgreements) {
      if (ag.premise) agreementLinkedPremiseIds.add(ag.premise.id);
    }
  }

  // Premises owned directly by the customer but not reached through
  // an agreement (the "pure landlord" case). Premises that agreements
  // point at are added later, when we process the agreement.
  for (const p of customer.ownedPremises) {
    if (agreementLinkedPremiseIds.has(p.id)) continue;
    const nid = `premise:${p.id}`;
    if (premiseNodeIds.has(nid)) continue;
    premiseNodeIds.add(nid);
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
      id: `edge:${customer.id}->${p.id}`,
      from: `customer:${customer.id}`,
      to: nid,
      kind: "owns_premise",
      validFrom: p.createdAt.toISOString(),
      validTo: null,
    });
  }

  // Accounts → Agreements → Meters, Accounts → Service Requests.
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
      id: `edge:${customer.id}->${acc.id}`,
      from: `customer:${customer.id}`,
      to: accNodeId,
      kind: "owns_account",
      validFrom: acc.createdAt.toISOString(),
      validTo: acc.closedAt ? acc.closedAt.toISOString() : null,
    });
    events.push({
      id: `evt:account-opened:${acc.id}`,
      occurredAt: acc.createdAt.toISOString(),
      kind: "account.opened",
      label: `Account ${acc.accountNumber} opened`,
      relatedNodeIds: [accNodeId],
    });
    if (acc.closedAt) {
      events.push({
        id: `evt:account-closed:${acc.id}`,
        occurredAt: acc.closedAt.toISOString(),
        kind: "account.closed",
        label: `Account ${acc.accountNumber} closed`,
        relatedNodeIds: [accNodeId],
      });
    }

    for (const ag of acc.serviceAgreements) {
      const agNodeId = `agreement:${ag.id}`;
      nodes.push({
        id: agNodeId,
        type: "agreement",
        label: ag.agreementNumber,
        subtext: `${ag.commodity?.name ?? ""} · ${ag.rateSchedule?.code ?? ""}`,
        data: {
          id: ag.id,
          agreementNumber: ag.agreementNumber,
          status: ag.status,
          commodity: ag.commodity,
          rateSchedule: ag.rateSchedule,
          startDate: ag.startDate.toISOString(),
          endDate: ag.endDate ? ag.endDate.toISOString() : null,
        },
        validFrom: ag.startDate.toISOString(),
        validTo: ag.endDate ? ag.endDate.toISOString() : null,
      });
      edges.push({
        id: `edge:${acc.id}->${ag.id}`,
        from: accNodeId,
        to: agNodeId,
        kind: "has_agreement",
        validFrom: ag.startDate.toISOString(),
        validTo: ag.endDate ? ag.endDate.toISOString() : null,
      });
      events.push({
        id: `evt:agreement-signed:${ag.id}`,
        occurredAt: ag.startDate.toISOString(),
        kind: "agreement.signed",
        label: `Agreement ${ag.agreementNumber} (${ag.commodity?.name ?? ""}) signed`,
        relatedNodeIds: [agNodeId, accNodeId],
      });
      if (ag.endDate) {
        events.push({
          id: `evt:agreement-ended:${ag.id}`,
          occurredAt: ag.endDate.toISOString(),
          kind: "agreement.ended",
          label: `Agreement ${ag.agreementNumber} ended`,
          relatedNodeIds: [agNodeId],
        });
      }

      // Premise referenced by the agreement — dedupe with the owned
      // premises set and add an at_premise edge from the agreement.
      if (ag.premise) {
        const pNodeId = `premise:${ag.premise.id}`;
        if (!premiseNodeIds.has(pNodeId)) {
          premiseNodeIds.add(pNodeId);
          nodes.push({
            id: pNodeId,
            type: "premise",
            label: ag.premise.addressLine1,
            subtext: `${ag.premise.city}, ${ag.premise.state} ${ag.premise.zip}`,
            data: {
              id: ag.premise.id,
              addressLine1: ag.premise.addressLine1,
              city: ag.premise.city,
              state: ag.premise.state,
              zip: ag.premise.zip,
              premiseType: ag.premise.premiseType,
              status: ag.premise.status,
            },
            validFrom: ag.premise.createdAt.toISOString(),
            validTo: null,
          });
        }
        edges.push({
          id: `edge:${ag.id}->${ag.premise.id}`,
          from: agNodeId,
          to: pNodeId,
          kind: "at_premise",
          validFrom: ag.startDate.toISOString(),
          validTo: ag.endDate ? ag.endDate.toISOString() : null,
        });
      }

      // Meters attached through the service_agreement_meter junction.
      for (const agm of ag.meters) {
        const m = agm.meter;
        const mNodeId = `meter:${m.id}`;
        if (!meterNodeIds.has(mNodeId)) {
          meterNodeIds.add(mNodeId);
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
          events.push({
            id: `evt:meter-installed:${m.id}`,
            occurredAt: m.installDate.toISOString(),
            kind: "meter.installed",
            label: `Meter ${m.meterNumber} installed`,
            relatedNodeIds: [mNodeId],
          });
          if (m.removalDate) {
            events.push({
              id: `evt:meter-removed:${m.id}`,
              occurredAt: m.removalDate.toISOString(),
              kind: "meter.removed",
              label: `Meter ${m.meterNumber} removed`,
              relatedNodeIds: [mNodeId],
            });
          }
        }
        edges.push({
          id: `edge:${ag.id}->${m.id}`,
          from: agNodeId,
          to: mNodeId,
          kind: "measured_by",
          validFrom: ag.startDate.toISOString(),
          validTo: ag.endDate ? ag.endDate.toISOString() : null,
        });
      }
    }

    // Service requests on this account.
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
      edges.push({
        id: `edge:${acc.id}->${sr.id}`,
        from: accNodeId,
        to: srNodeId,
        kind: "filed_against",
        validFrom: sr.createdAt.toISOString(),
        validTo: sr.completedAt
          ? sr.completedAt.toISOString()
          : sr.cancelledAt
            ? sr.cancelledAt.toISOString()
            : null,
      });
      if (sr.premiseId) {
        const pNodeId = `premise:${sr.premiseId}`;
        if (premiseNodeIds.has(pNodeId)) {
          edges.push({
            id: `edge:${sr.id}->${sr.premiseId}`,
            from: srNodeId,
            to: pNodeId,
            kind: "filed_at_premise",
            validFrom: sr.createdAt.toISOString(),
            validTo: null,
          });
        }
      }
      events.push({
        id: `evt:sr-filed:${sr.id}`,
        occurredAt: sr.createdAt.toISOString(),
        kind: "service_request.filed",
        label: `Service request ${sr.requestNumber} (${sr.requestType}) filed`,
        relatedNodeIds: [srNodeId, accNodeId],
      });
      if (sr.completedAt) {
        events.push({
          id: `evt:sr-completed:${sr.id}`,
          occurredAt: sr.completedAt.toISOString(),
          kind: "service_request.completed",
          label: `Service request ${sr.requestNumber} completed`,
          relatedNodeIds: [srNodeId],
        });
      }
    }
  }

  // Stable chronological timeline — oldest first.
  events.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));

  // Cap total nodes (keep customer + closest ones). Drop from the tail
  // end which, with our traversal order, contains the least-recent SRs.
  const truncated = nodes.length > NODE_CAP;
  const finalNodes = truncated ? nodes.slice(0, NODE_CAP) : nodes;
  const keptIds = new Set(finalNodes.map((n) => n.id));
  const finalEdges = edges.filter((e) => keptIds.has(e.from) && keptIds.has(e.to));

  return {
    customerId: customer.id,
    nodes: finalNodes,
    edges: finalEdges,
    events,
    truncated,
  };
}
