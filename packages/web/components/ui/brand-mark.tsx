"use client";

/**
 * The product mark: accent square, name, and what this surface is.
 *
 * It lived inline in the sidebar's 56px brand row, which is the only
 * place the admin app shows it. The platform screens have no sidebar, so
 * the mark has to sit in their header instead — and drawing a second one
 * there is how two marks end up subtly different. One component, two
 * homes.
 *
 * The subtitle is the surface, not a tagline: "Admin Portal" inside a
 * tenant, "Platform" above them.
 */
export function BrandMark({ subtitle = "Admin Portal" }: { subtitle?: string }) {
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
        <div style={{ color: "var(--text-muted)", fontSize: 11, whiteSpace: "nowrap" }}>
          {subtitle}
        </div>
      </div>
    </>
  );
}
