/**
 * What the database reports about whether it is enforcing isolation.
 *
 * Gathered by `assertRlsEnforced` in `prisma.ts`; judged by
 * `rlsComplaints` below. The two are separated because the gathering
 * needs a database and the judgement needs to be read.
 */
export type RlsPosture = {
  /** The role the application's own pool connected as. */
  currentUser: string;
  /** Whether that role holds `rolsuper` or `rolbypassrls`. */
  bypasses: boolean;
  /** Tables that have a policy but do not FORCE it on their owner. */
  unforcedPoliciedTables: string[];
  /** Whether `DATABASE_URL_PLATFORM` names a connection of its own. */
  platformUrlSet: boolean;
};

/**
 * The reasons this connection does not enforce tenant isolation, in
 * plain sentences, empty when there are none.
 *
 * Each reason is independent and each is a deployment mistake rather
 * than a code one, which is why they are reported together: a
 * deployment told about one of three would fix it, restart, and be told
 * about the next.
 */
export function rlsComplaints(posture: RlsPosture): string[] {
  const complaints: string[] = [];

  if (posture.bypasses) {
    complaints.push(
      `the application connects as "${posture.currentUser}", which bypasses row-level security ` +
        `(SUPERUSER or BYPASSRLS). Every policy on every table is advisory for this role, so ` +
        `tenant isolation rests entirely on each query remembering to filter by utility_id. ` +
        `Connect as cis_app and keep the owner role for migrations.`,
    );
  }

  if (posture.unforcedPoliciedTables.length > 0) {
    complaints.push(
      `${posture.unforcedPoliciedTables.length} table(s) carry a policy their owner is exempt ` +
        `from, because they do not FORCE ROW LEVEL SECURITY: ` +
        `${posture.unforcedPoliciedTables.join(", ")}. A table created by a migration is in this ` +
        `state until the FORCE is applied.`,
    );
  }

  /*
   * Only worth saying when the application role is confined. With an
   * exempt role the fallback is a connection that can already cross
   * tenants, so an unset platform URL is the correct configuration
   * rather than a second fault — and reporting it alongside the bypass
   * would read as two problems needing two fixes.
   */
  if (!posture.platformUrlSet && !posture.bypasses) {
    complaints.push(
      `DATABASE_URL_PLATFORM is unset while the application role is confined by RLS, so the ` +
        `platform pool falls back to it. Cross-tenant work — the platform console and the ` +
        `all-tenants queue sweeps — will read nothing and report success.`,
    );
  }

  return complaints;
}
