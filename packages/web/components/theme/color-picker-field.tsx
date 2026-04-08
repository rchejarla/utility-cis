"use client";

export interface ColorPickerFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
}

export function ColorPickerField({ label, value, onChange }: ColorPickerFieldProps) {
  // Ensure we have a valid hex string for the color input
  const safeValue = /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#000000";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
      <label
        style={{
          fontSize: "11px",
          fontWeight: "500",
          color: "var(--text-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
        }}
      >
        {label}
      </label>
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        {/* Color swatch / native color picker */}
        <div style={{ position: "relative", flexShrink: 0 }}>
          <input
            type="color"
            value={safeValue}
            onChange={(e) => onChange(e.target.value)}
            style={{
              width: "36px",
              height: "36px",
              padding: "2px",
              borderRadius: "6px",
              border: "1px solid var(--border)",
              background: "var(--bg-elevated)",
              cursor: "pointer",
              appearance: "none",
              WebkitAppearance: "none",
            }}
          />
        </div>
        {/* Hex text input */}
        <input
          type="text"
          value={value}
          onChange={(e) => {
            const val = e.target.value;
            // Accept partial typing or full hex
            onChange(val);
          }}
          onBlur={(e) => {
            // Normalize on blur — if not valid hex, revert to safe value
            if (!/^#[0-9a-fA-F]{6}$/.test(e.target.value)) {
              onChange(safeValue);
            }
          }}
          placeholder="#000000"
          maxLength={7}
          spellCheck={false}
          style={{
            flex: 1,
            padding: "7px 10px",
            borderRadius: "6px",
            border: "1px solid var(--border)",
            background: "var(--bg-elevated)",
            color: "var(--text-primary)",
            fontSize: "13px",
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            letterSpacing: "0.04em",
            outline: "none",
          }}
        />
      </div>
    </div>
  );
}
