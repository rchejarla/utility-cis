"use client";

import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api-client";

/**
 * Picks an agreement's service class — the customer category the service
 * is priced as (residential, single family, commercial…). Required: a rate
 * charge restricted to a class applies only to agreements in it.
 *
 * Classes are defined per commodity, because each service's tariff
 * defines its own, so the choices follow `commodityId` and the selection
 * clears when the commodity changes. With nothing chosen yet, the class
 * whose code matches the account's type is pre-selected (a Residential
 * account's electric agreement → "residential"); staff can change it.
 */

export interface ServiceClassOption {
  id: string;
  code: string;
  label: string;
}

export function ServiceClassSelect({
  commodityId,
  value,
  onChange,
  accountType,
  style,
  id,
}: {
  commodityId: string;
  value: string;
  onChange: (id: string) => void;
  /** The account's type, for the pre-selection — e.g. "RESIDENTIAL". */
  accountType?: string | null;
  style?: React.CSSProperties;
  id?: string;
}) {
  const [options, setOptions] = useState<ServiceClassOption[] | null>(null);

  useEffect(() => {
    if (!commodityId) {
      setOptions(null);
      return;
    }
    let live = true;
    setOptions(null);
    apiClient
      .get<{ data: ServiceClassOption[] }>("/api/v1/service-agreements/service-classes", { commodityId })
      .then((res) => live && setOptions(res.data ?? []))
      .catch(() => live && setOptions([]));
    return () => {
      live = false;
    };
  }, [commodityId]);

  // A value from another commodity is no longer a choice; drop it.
  useEffect(() => {
    if (options && value && !options.some((o) => o.id === value)) onChange("");
  }, [options, value, onChange]);

  // Pre-select from the account type when nothing is chosen.
  useEffect(() => {
    if (!options || value || !accountType) return;
    const match = options.find((o) => o.code.toLowerCase() === accountType.toLowerCase());
    if (match) onChange(match.id);
  }, [options, value, accountType, onChange]);

  const placeholder = !commodityId
    ? "Pick the commodity first"
    : options === null
      ? "Loading classes…"
      : options.length === 0
        ? "No classes defined for this commodity"
        : "Select service class...";

  return (
    <select
      id={id}
      aria-label="Service class"
      style={style}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={!commodityId || options === null || options.length === 0}
      required
    >
      <option value="">{placeholder}</option>
      {(options ?? []).map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
