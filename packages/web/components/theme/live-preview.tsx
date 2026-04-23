"use client";

export interface PreviewTheme {
  bgDeep: string;
  bgCard: string;
  bgElevated: string;
  border: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  accentPrimary: string;
  accentSecondary: string;
  success: string;
  danger: string;
  warning: string;
  borderRadius: number;
  bodyFont: string;
  displayFont: string;
}

interface LivePreviewProps {
  theme: PreviewTheme;
}

export function LivePreview({ theme }: LivePreviewProps) {
  const radius = `${theme.borderRadius}px`;
  const fontFamily = theme.bodyFont !== "default" ? `'${theme.bodyFont}', sans-serif` : "inherit";

  // Derive some surface colors
  const cardBg = theme.bgCard;
  const elevatedBg = theme.bgElevated;

  const tableRows = [
    { id: "ACC-001", name: "Main Campus", commodity: "WATER", status: "Active" },
    { id: "ACC-002", name: "North Tower", commodity: "ELECTRIC", status: "Inactive" },
    { id: "ACC-003", name: "Parking Lot A", commodity: "GAS", status: "Active" },
  ];

  // Matches CommodityBadge's mapping so the preview reads the same
  // tokens a real badge would. Using var() so the preview tracks the
  // currently-active theme rather than baking the dark-theme values in.
  const commodityColors: Record<string, { bg: string; text: string; border: string }> = {
    WATER: { bg: "var(--info-subtle)", text: "var(--info)", border: "var(--info)" },
    ELECTRIC: { bg: "var(--warning-subtle)", text: "var(--warning)", border: "var(--warning)" },
    GAS: { bg: "var(--accent-tertiary-subtle)", text: "var(--accent-tertiary)", border: "var(--accent-tertiary)" },
  };

  return (
    <div
      style={{
        height: "100%",
        background: theme.bgDeep,
        borderRadius: radius,
        border: `1px solid ${theme.border}`,
        overflow: "auto",
        fontFamily,
        display: "flex",
        flexDirection: "column",
        gap: "16px",
        padding: "24px",
      }}
    >
      {/* Mini topbar */}
      <div
        style={{
          background: cardBg,
          borderRadius: radius,
          border: `1px solid ${theme.border}`,
          padding: "10px 16px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <div
            style={{
              width: "24px",
              height: "24px",
              borderRadius: "6px",
              background: theme.accentPrimary,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#fff",
              fontSize: "11px",
              fontWeight: "bold",
            }}
          >
            U
          </div>
          <span
            style={{
              fontSize: "13px",
              fontWeight: "600",
              color: theme.textPrimary,
              fontFamily: theme.displayFont !== "default" ? `'${theme.displayFont}', sans-serif` : fontFamily,
            }}
          >
            Utility CIS
          </span>
        </div>
        <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
          <div
            style={{
              width: "6px",
              height: "6px",
              borderRadius: "50%",
              background: theme.success,
            }}
          />
          <span style={{ fontSize: "11px", color: theme.textSecondary }}>Connected</span>
        </div>
      </div>

      {/* Page title row */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h2
            style={{
              margin: "0 0 4px",
              fontSize: "20px",
              fontWeight: "700",
              color: theme.textPrimary,
              fontFamily: theme.displayFont !== "default" ? `'${theme.displayFont}', sans-serif` : fontFamily,
            }}
          >
            Premises
          </h2>
          <p style={{ margin: 0, fontSize: "13px", color: theme.textSecondary }}>
            142 locations across 5 regions
          </p>
        </div>
        <button
          style={{
            padding: "8px 16px",
            borderRadius: radius,
            background: theme.accentPrimary,
            border: "none",
            color: "#fff",
            fontSize: "13px",
            fontWeight: "500",
            cursor: "pointer",
            fontFamily,
          }}
        >
          + Add Premise
        </button>
      </div>

      {/* Stats row */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "12px" }}>
        {[
          { label: "Total Meters", value: "284", color: theme.accentPrimary },
          { label: "Active Accounts", value: "191", color: theme.success },
          { label: "Pending Review", value: "12", color: theme.warning },
        ].map((stat) => (
          <div
            key={stat.label}
            style={{
              background: cardBg,
              border: `1px solid ${theme.border}`,
              borderRadius: radius,
              padding: "14px",
            }}
          >
            <div style={{ fontSize: "11px", color: theme.textMuted, fontWeight: "500", marginBottom: "4px" }}>
              {stat.label}
            </div>
            <div style={{ fontSize: "22px", fontWeight: "700", color: stat.color }}>{stat.value}</div>
          </div>
        ))}
      </div>

      {/* Buttons row */}
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: "11px", color: theme.textMuted, fontWeight: "500" }}>Buttons:</span>
        <button
          style={{
            padding: "6px 14px",
            borderRadius: radius,
            background: theme.accentPrimary,
            border: "none",
            color: "#fff",
            fontSize: "12px",
            fontWeight: "500",
            cursor: "pointer",
            fontFamily,
          }}
        >
          Primary
        </button>
        <button
          style={{
            padding: "6px 14px",
            borderRadius: radius,
            background: "transparent",
            border: `1px solid ${theme.border}`,
            color: theme.textSecondary,
            fontSize: "12px",
            fontWeight: "500",
            cursor: "pointer",
            fontFamily,
          }}
        >
          Ghost
        </button>
        <button
          style={{
            padding: "6px 14px",
            borderRadius: radius,
            background: `${theme.accentPrimary}18`,
            border: `1px solid ${theme.accentPrimary}40`,
            color: theme.accentPrimary,
            fontSize: "12px",
            fontWeight: "500",
            cursor: "pointer",
            fontFamily,
          }}
        >
          Tinted
        </button>
        <button
          style={{
            padding: "6px 14px",
            borderRadius: radius,
            background: `${theme.danger}18`,
            border: `1px solid ${theme.danger}40`,
            color: theme.danger,
            fontSize: "12px",
            fontWeight: "500",
            cursor: "pointer",
            fontFamily,
          }}
        >
          Danger
        </button>
      </div>

      {/* Badges row */}
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: "11px", color: theme.textMuted, fontWeight: "500" }}>Badges:</span>
        {Object.entries(commodityColors).map(([name, style]) => (
          <span
            key={name}
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "2px 8px",
              borderRadius: "6px",
              background: style.bg,
              border: `1px solid ${style.border}`,
              fontSize: "11px",
              fontWeight: "600",
              color: style.text,
              letterSpacing: "0.04em",
              fontFamily: "monospace",
            }}
          >
            {name}
          </span>
        ))}
      </div>

      {/* Status pills */}
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: "11px", color: theme.textMuted, fontWeight: "500" }}>Status:</span>
        {[
          { label: "Active", dot: theme.success, text: theme.success, bg: `${theme.success}18` },
          { label: "Inactive", dot: theme.warning, text: theme.warning, bg: `${theme.warning}18` },
          { label: "Suspended", dot: theme.danger, text: theme.danger, bg: `${theme.danger}18` },
        ].map((s) => (
          <span
            key={s.label}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "5px",
              padding: "2px 8px",
              borderRadius: "999px",
              background: s.bg,
              fontSize: "11px",
              fontWeight: "500",
              color: s.text,
            }}
          >
            <span
              style={{
                width: "5px",
                height: "5px",
                borderRadius: "50%",
                background: s.dot,
                flexShrink: 0,
                display: "inline-block",
              }}
            />
            {s.label}
          </span>
        ))}
      </div>

      {/* Mini data table */}
      <div
        style={{
          background: cardBg,
          border: `1px solid ${theme.border}`,
          borderRadius: radius,
          overflow: "hidden",
        }}
      >
        {/* Table header */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1.5fr 1fr 1fr",
            padding: "10px 16px",
            background: elevatedBg,
            borderBottom: `1px solid ${theme.border}`,
          }}
        >
          {["Account ID", "Location", "Commodity", "Status"].map((h) => (
            <span
              key={h}
              style={{
                fontSize: "11px",
                fontWeight: "600",
                color: theme.textMuted,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
              }}
            >
              {h}
            </span>
          ))}
        </div>
        {/* Rows */}
        {tableRows.map((row, i) => {
          const comm = commodityColors[row.commodity] ?? { bg: "transparent", text: theme.textSecondary, border: theme.border };
          const isActive = row.status === "Active";
          return (
            <div
              key={row.id}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1.5fr 1fr 1fr",
                padding: "10px 16px",
                borderBottom: i < tableRows.length - 1 ? `1px solid ${theme.border}` : "none",
                alignItems: "center",
              }}
            >
              <span
                style={{
                  fontSize: "12px",
                  fontFamily: "monospace",
                  color: theme.accentPrimary,
                  fontWeight: "500",
                }}
              >
                {row.id}
              </span>
              <span style={{ fontSize: "13px", color: theme.textPrimary }}>{row.name}</span>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  padding: "2px 7px",
                  borderRadius: "5px",
                  background: comm.bg,
                  border: `1px solid ${comm.border}`,
                  fontSize: "10px",
                  fontWeight: "600",
                  color: comm.text,
                  fontFamily: "monospace",
                  letterSpacing: "0.04em",
                  width: "fit-content",
                }}
              >
                {row.commodity}
              </span>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "5px",
                  padding: "2px 8px",
                  borderRadius: "999px",
                  background: isActive ? `${theme.success}18` : `${theme.warning}18`,
                  fontSize: "11px",
                  fontWeight: "500",
                  color: isActive ? theme.success : theme.warning,
                  width: "fit-content",
                }}
              >
                <span
                  style={{
                    width: "5px",
                    height: "5px",
                    borderRadius: "50%",
                    background: isActive ? theme.success : theme.warning,
                    display: "inline-block",
                  }}
                />
                {row.status}
              </span>
            </div>
          );
        })}
      </div>

      {/* Form example */}
      <div
        style={{
          background: cardBg,
          border: `1px solid ${theme.border}`,
          borderRadius: radius,
          padding: "16px",
        }}
      >
        <div style={{ fontSize: "13px", fontWeight: "600", color: theme.textPrimary, marginBottom: "12px" }}>
          Sample Form
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {["Address Line 1", "City"].map((field) => (
            <div key={field} style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              <label style={{ fontSize: "11px", fontWeight: "500", color: theme.textMuted, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                {field}
              </label>
              <div
                style={{
                  padding: "8px 12px",
                  borderRadius: radius,
                  border: `1px solid ${theme.border}`,
                  background: elevatedBg,
                  color: theme.textSecondary,
                  fontSize: "13px",
                }}
              >
                {field === "Address Line 1" ? "123 Main Street" : "Springfield"}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
