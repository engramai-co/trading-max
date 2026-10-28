/** The Trading Max symbol; its colours follow the active colour scheme. */
export function BrandMark({ size, className }: { size: number; className?: string }) {
  return (
    <svg
      viewBox="160 160 680 680"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path className="mx-mark-ink" d="M180 250H820V348H558V750H442V348H180ZM180 366H280V750H180ZM720 366H820V750H720Z" />
      <path className="mx-mark-accent" d="M280 366L424 528V684L280 522ZM720 366L576 528V684L720 522Z" />
    </svg>
  );
}
