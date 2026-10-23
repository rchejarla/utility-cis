"use client";

/**
 * Everything a bill row can do, wherever a bill is listed.
 *
 * Lifted out of the bills page so the account's Bills tab offers the
 * same acts instead of a "View →" link and nothing else. The
 * availability rules travel with the acts, which is the point: each one
 * is only offered where it can succeed, and a second copy of those rules
 * on another screen would be a second thing to get wrong.
 *
 *  - Reverse: there is no void (§3.5). A wrong charge is reversed and
 *    both sides stay on the ledger, so it needs a charge that is not
 *    already reversed.
 *  - Waive / write off: both need something left to forgive. A settled
 *    charge has nothing outstanding; a reversed one no longer stands.
 *  - Regenerate: replaces the stored PDF, so the bill must be posted.
 *
 * One act stays inline and it is the one that only reads — getting the
 * bill as a PDF. Everything that moves money or overwrites something
 * sits behind More, a deliberate click away, so a row reads as a list of
 * bills rather than a control panel. Post is the exception that proves
 * the rule: it appears only before posting, when PDF cannot, so the row
 * never carries more than one inline action.
 */

import { useState } from "react";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import { useToast } from "@/components/ui/toast";
import { RecordPaymentDialog } from "@/components/ar/record-payment-dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { AdjustDialog, type AdjustMode } from "@/components/ar/adjust-dialog";
import { BillPdfButton } from "@/components/bills/bill-pdf-button";
import { ActionMenu, type ActionMenuItem } from "@/components/ui/action-menu";

/** The fields these acts address. Both bill lists carry all of them. */
export interface BillActionFields {
  id: string;
  billNumber: string;
  total: string;
  postedAt: string | null;
  accountId: string;
  charge: { entryId: string; openAmount: string; reversed: boolean } | null;
  /**
   * Why this bill cannot be sent, or null when it is ready. From the
   * same rule the API refuses by, so the menu and the refusal agree.
   */
  blockedReason: string | null;
  /** The newest attempt, which decides Send versus Resend. */
  delivery: { status: string; sentAt: string | null; error: string | null } | null;
}

/** Carried over unchanged from the bills page, so the row looks the same. */
const POST_BTN = (busy: boolean): React.CSSProperties => ({
  padding: "3px 10px",
  fontSize: 10,
  fontWeight: 600,
  background: "var(--accent-primary)",
  color: "#fff",
  border: "none",
  borderRadius: "var(--radius)",
  cursor: busy ? "default" : "pointer",
  opacity: busy ? 0.6 : 1,
  fontFamily: "inherit",
  whiteSpace: "nowrap",
});

export function BillRowActions({
  bill,
  onChanged,
}: {
  bill: BillActionFields;
  /** Re-read whatever list this row belongs to; every act changes it. */
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const { canEdit } = usePermission("accounts");
  const { canCreate: canTakePayment, canEdit: canReverse } = usePermission("payments");
  const { canEdit: canForgive } = usePermission("ar_adjustments");

  const [posting, setPosting] = useState(false);
  const [payFor, setPayFor] = useState(false);
  const [voidCharge, setVoidCharge] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [adjust, setAdjust] = useState<AdjustMode | null>(null);
  const [regenerate, setRegenerate] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  async function post() {
    setPosting(true);
    try {
      await apiClient.post(`/api/v1/bills/${bill.id}/post`, {});
      toast(`Bill ${bill.billNumber} posted — it is now owed`, "success");
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to post bill", "error");
    } finally {
      setPosting(false);
    }
  }

  /**
   * Replace the stored PDF. The only writer of this; the PDF button
   * deliberately does not offer it, so the warning copy below is the one
   * place an operator is told what it does and does not do.
   */
  async function regenerateDocument() {
    setRegenerating(true);
    try {
      await apiClient.post(`/api/v1/bills/${bill.id}/document?force=true`, {});
      toast(`${bill.billNumber} was generated again`, "success");
      setRegenerate(false);
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not generate the bill again", "error");
    } finally {
      setRegenerating(false);
    }
  }

  async function reverseCharge() {
    if (!bill.charge) return;
    setVoiding(true);
    try {
      await apiClient.post(`/api/v1/ledger-entries/${bill.charge.entryId}/reverse`, {});
      toast(`${bill.billNumber} reversed — the charge no longer stands`, "success");
      setVoidCharge(false);
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not reverse the charge", "error");
    } finally {
      setVoiding(false);
    }
  }

  async function send() {
    try {
      await apiClient.post(`/api/v1/bills/${bill.id}/deliver`, {});
      toast(`${bill.billNumber} queued for delivery.`, "success");
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not send", "error");
    }
  }

  const items: ActionMenuItem[] = [];
  const open = bill.charge && !bill.charge.reversed && Number(bill.charge.openAmount) > 0;

  /*
   * Ordered by how often it is reached and how much it costs to get
   * wrong: taking money first, then the document, then forgiveness, and
   * reversal last — furthest from where the pointer lands when the menu
   * opens.
   *
   * Payment is account-scoped, not bill-scoped: recordPayment takes an
   * accountId and §6.3 allocates oldest-first across fees, manual debits
   * and then bills. The label says "account" so nobody reads it as
   * paying off this bill alone.
   */
  if (canTakePayment && bill.postedAt) {
    items.push({
      label: "Take payment on account",
      title: "Allocated oldest-first across what the account owes, not to this bill alone",
      onSelect: () => setPayFor(true),
    });
  }
  /*
   * Sending is behind More for the reason this menu exists: a row reads
   * as a list of bills, and an action reached now and then belongs a
   * deliberate click away rather than loose beside View Bill.
   *
   * Absent entirely when the bill cannot go — the Delivery column
   * beside it already says why, and an item that fails on click would
   * add nothing. `blockedReason` comes from the same rule the API
   * refuses by, so the menu and the refusal cannot disagree.
   */
  if (canEdit && bill.blockedReason === null) {
    items.push({
      label: bill.delivery ? "Resend" : "Send",
      title: bill.delivery
        ? "Queue this bill for delivery again; the earlier attempt stays on the record"
        : "Queue this bill for delivery to its customer",
      onSelect: () => void send(),
    });
  }
  if (canEdit && bill.postedAt) {
    items.push({
      label: "Regenerate PDF",
      title: "Replace the stored PDF with a freshly generated one",
      onSelect: () => setRegenerate(true),
    });
  }
  if (canForgive && open) {
    items.push({
      label: "Waive",
      title: "Forgive a charge that was correct",
      onSelect: () => setAdjust("waive"),
    });
    items.push({
      label: "Write off",
      title: "Give up on collecting this charge",
      onSelect: () => setAdjust("writeOff"),
    });
  }
  if (canReverse && bill.charge && !bill.charge.reversed) {
    items.push({
      label: "Reverse charge",
      tone: "danger",
      title: "Negate this bill's charge; both sides stay on the ledger",
      onSelect: () => setVoidCharge(true),
    });
  }

  return (
    <div style={{ display: "flex", gap: 6 }}>
      {canEdit && !bill.postedAt && (
        <button onClick={() => void post()} disabled={posting} style={POST_BTN(posting)}>
          {posting ? "Posting…" : "Post"}
        </button>
      )}
      <BillPdfButton
        billId={bill.id}
        billNumber={bill.billNumber}
        disabled={!bill.postedAt}
        onChanged={onChanged}
      />
      <ActionMenu aria-label={`More actions for ${bill.billNumber}`} items={items} />

      {payFor && (
        <RecordPaymentDialog
          accountId={bill.accountId}
          onClose={() => setPayFor(false)}
          onRecorded={() => {
            setPayFor(false);
            onChanged();
          }}
        />
      )}

      {adjust && bill.charge && (
        <AdjustDialog
          mode={adjust}
          accountId={bill.accountId}
          target={{
            id: bill.charge.entryId,
            amount: bill.total,
            openAmount: bill.charge.openAmount,
            label: `Bill ${bill.billNumber}`,
          }}
          onClose={() => setAdjust(null)}
          onDone={() => {
            setAdjust(null);
            onChanged();
          }}
        />
      )}

      {regenerate && (
        <ConfirmDialog
          title={`Generate ${bill.billNumber} again?`}
          /*
           * Both sentences are here because operators expect the wrong
           * thing otherwise. "Generate again" sounds like it might
           * recalculate the bill, and it does not; and it overwrites
           * rather than keeping the old copy, which is the part that
           * cannot be undone.
           */
          message={
            "This does not change what is owed — nothing about the bill is recalculated. " +
            "It replaces the stored PDF with a freshly generated one; the previous copy is not kept. " +
            "Use it when the bill's own details have been corrected, or after a template change."
          }
          confirmLabel={regenerating ? "Generating…" : "Generate again"}
          destructive={false}
          onConfirm={() => void regenerateDocument()}
          onCancel={() => setRegenerate(false)}
        />
      )}

      {voidCharge && (
        <ConfirmDialog
          title={`Reverse ${bill.billNumber}?`}
          message={
            `This reverses the $${Number(bill.total).toFixed(2)} charge this bill raised, so it is no longer owed. ` +
            "Both the charge and its reversal stay on the ledger — nothing is deleted, and the bill itself is unchanged. " +
            "Use this when the charge was wrong. To forgive a charge that was correct, waive it instead."
          }
          confirmLabel={voiding ? "Reversing…" : "Reverse charge"}
          onConfirm={() => void reverseCharge()}
          onCancel={() => setVoidCharge(false)}
        />
      )}
    </div>
  );
}
