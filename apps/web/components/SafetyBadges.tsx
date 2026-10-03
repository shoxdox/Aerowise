const LABELS: Record<string, string> = {
  dog: "Dog",
  locked_gate: "Locked gate",
  aggressive_animal: "Aggressive animal",
  hazard: "Hazard",
  call_ahead: "Call ahead",
};

export function SafetyBadges({ flags }: { flags: string[] }) {
  if (flags.length === 0) return null;
  return (
    <span className="badges">
      {flags.map((f) => (
        <span key={f} className="badge warn">
          {LABELS[f] ?? f}
        </span>
      ))}
    </span>
  );
}

export const SAFETY_FLAG_LABELS = LABELS;
