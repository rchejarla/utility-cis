export interface AgreementLabelInput {
  agreementNumber: string;
  commodity?: { name: string } | null;
  premise?: { addressLine1: string } | null;
}

export function formatAgreementLabel(agreement: AgreementLabelInput): string {
  const parts: string[] = [agreement.agreementNumber];
  if (agreement.commodity?.name) parts.push(agreement.commodity.name);
  if (agreement.premise?.addressLine1) parts.push(agreement.premise.addressLine1);
  return parts.join(" · ");
}
