"use client";

/**
 * The product mark: accent square, name, and where you are.
 *
 * It lived inline in the sidebar's 56px brand row, which is the only
 * place the admin app shows it. The platform screens have no sidebar, so
 * the mark has to sit in their header instead — and drawing a second one
 * there is how two marks end up subtly different. One component, two
 * homes.
 *
 * The second line is the surface, not a tagline: "Admin Portal" inside a
 * tenant, "Platform" above them. **Inside a tenant the tenant's own name
 * takes that line**, because "which utility" is the sharper form of the
 * same question and it was answered nowhere in the admin chrome — every
 * screen below this one is one tenant's data, and an operator with two
 * tabs open had nothing on screen saying which one they were about to
 * charge. The row has one line for it, so the tenant replaces the
 * caption rather than joining it.
 *
 * `tenant` is null above the tenants and also when `/auth/me` could not
 * be read, and the caption returns in both cases. Naming no tenant is
 * honest; naming the wrong one is not.
 */
export function BrandMark({
  subtitle = "Admin Portal",
  tenant = null,
}: {
  subtitle?: string;
  tenant?: string | null;
}) {
  const second = tenant?.trim() || subtitle;
  return (
    <>
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: 8,
          background: "var(--accent-primary)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          color: "white",
          fontWeight: "bold",
          fontSize: 14,
        }}
      >
        U
      </div>
      <div style={{ overflow: "hidden" }}>
        <div
          style={{
            color: "var(--text-primary)",
            fontWeight: 600,
            fontSize: 14,
            lineHeight: 1.2,
            whiteSpace: "nowrap",
          }}
        >
          Utility CIS
        </div>
        <div
          style={{
            color: "var(--text-muted)",
            fontSize: 11,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
          // A tenant name is as long as a tenant chose to make it, and
          // this row is 240px wide. Clipped with the full name on hover,
          // rather than wrapping a 56px row to two lines.
          title={second}
        >
          {second}
        </div>
      </div>
    </>
  );
}
