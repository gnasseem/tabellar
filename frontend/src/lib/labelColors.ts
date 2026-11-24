// Label colours. A label's colour only ever shows as a small dot beside its
// name, so the set is short and muted to sit with the neutral interface. This
// is the one file where colour values are written out.
const C = {
  brick: "#b4604e",
  ochre: "#b38a3e",
  moss: "#72894c",
  teal: "#3f8a86",
  blue: "#5b7fa6",
  plum: "#86699f",
  rose: "#ad6784",
  stone: "#8a857d",
};

export const LABEL_COLORS: { hex: string; name: string }[] = [
  { hex: C.brick, name: "Brick" },
  { hex: C.ochre, name: "Ochre" },
  { hex: C.moss, name: "Moss" },
  { hex: C.teal, name: "Teal" },
  { hex: C.blue, name: "Blue" },
  { hex: C.plum, name: "Plum" },
  { hex: C.rose, name: "Rose" },
  { hex: C.stone, name: "Stone" },
];

// Labels saved before the palette was reduced carry brighter colours; each is
// shown as its nearest muted one.
const OLDER: Record<string, string> = {
  "#ef4444": C.brick,
  "#f97316": C.ochre,
  "#eab308": C.ochre,
  "#22c55e": C.moss,
  "#10b981": C.moss,
  "#06b6d4": C.teal,
  "#14b8a6": C.teal,
  "#3b82f6": C.blue,
  "#6366f1": C.plum,
  "#8b5cf6": C.plum,
  "#a855f7": C.plum,
  "#ec4899": C.rose,
  "#6b7280": C.stone,
  "#64748b": C.stone,
  "#1e293b": C.stone,
};

export function labelColor(stored: string | null | undefined): string {
  const hex = (stored || "").toLowerCase();
  if (LABEL_COLORS.some((c) => c.hex === hex)) return hex;
  return OLDER[hex] ?? C.stone;
}

// A slug never used before, so mail tagged with a deleted label's slug does
// not land in a new one of the same name.
export function slugOf(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "label";
  return `${base}-${Math.random().toString(36).slice(2, 7)}`;
}
