/**
 * Known notification event types. Each entry is a system event that
 * CIS code can trigger via sendNotification(). Admins create templates
 * for these events — they cannot invent new event types because there
 * is no code path to fire them.
 *
 * Adding a new event type requires:
 * 1. Add it here
 * 2. Add a sendNotification() call in the relevant service
 * 3. Add a seed template with sample content
 */
export const NOTIFICATION_EVENT_TYPES = [
  { key: "delinquency.tier_1", label: "Past Due Reminder (Tier 1)", category: "Delinquency" },
  { key: "delinquency.tier_2", label: "Formal Past Due Notice (Tier 2)", category: "Delinquency" },
  { key: "delinquency.tier_3", label: "Shut-Off Warning (Tier 3)", category: "Delinquency" },
  { key: "delinquency.tier_4", label: "Service Disconnection (Tier 4)", category: "Delinquency" },
  { key: "portal.welcome", label: "Portal Welcome", category: "Portal" },
  { key: "portal.password_reset", label: "Password Reset", category: "Portal" },
  { key: "meter.high_usage", label: "High Usage Alert", category: "Meter Events" },
  { key: "meter.leak_detected", label: "Possible Leak Detected", category: "Meter Events" },
  { key: "service.move_in_confirmation", label: "Move-In Confirmation", category: "Service" },
  { key: "service.move_out_confirmation", label: "Move-Out Confirmation", category: "Service" },
] as const;

export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number]["key"];
