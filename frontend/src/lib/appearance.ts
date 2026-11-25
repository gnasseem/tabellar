// How the window looks, as the user set it in Settings, Appearance: kept in
// profiles.theme and profiles.appearance, applied to the root element so every
// token and every rem in the page follows. See the tokens in index.css.
import { useEffect, useState } from "react";

export type ThemeChoice = "light" | "dark" | "auto";
export type Accent = "red" | "blue" | "teal" | "violet" | "graphite";
export type Density = "comfortable" | "compact";
export type TextSize = "small" | "default" | "large" | "larger";
export type Appearance = { accent: Accent; density: Density; text: TextSize; hidden: string[] };

export const ACCENTS: { id: Accent; label: string }[] = [
  { id: "red", label: "Red" },
  { id: "blue", label: "Blue" },
  { id: "teal", label: "Teal" },
  { id: "violet", label: "Violet" },
  { id: "graphite", label: "Graphite" },
];
// The root font size in px; lengths are written as they are at 16.
const ROOT: Record<TextSize, number> = { small: 16, default: 17, large: 18.5, larger: 20 };
// List rows and group headers at 16px (--row and --head in index.css).
const ROW: Record<Density, number> = { comfortable: 34, compact: 29 };
const HEAD: Record<Density, number> = { comfortable: 38, compact: 32 };

export function appearanceOf(profile: { appearance?: unknown } | null | undefined): Appearance {
  const a = (profile?.appearance ?? {}) as Partial<Appearance>;
  return {
    accent: ACCENTS.some((x) => x.id === a.accent) ? a.accent! : "red",
    density: a.density === "compact" ? "compact" : "comfortable",
    text: a.text && a.text in ROOT ? a.text : "default",
    hidden: Array.isArray(a.hidden) ? a.hidden : [],
  };
}

// Pixel sizes for what is laid out in code (windowed lists).
export function sizesOf(a: Appearance): { scale: number; row: number; head: number } {
  const scale = ROOT[a.text] / 16;
  return { scale, row: ROW[a.density] * scale, head: HEAD[a.density] * scale };
}

export function applyAppearance(a: Appearance): void {
  const root = document.documentElement;
  root.dataset.accent = a.accent;
  root.dataset.density = a.density;
  root.style.fontSize = `${ROOT[a.text]}px`;
}

// The theme to show for a choice; "auto" follows the Mac. Sets the class the
// tokens hang on before the page is painted.
export function useTheme(choice: ThemeChoice): "light" | "dark" {
  const [system, setSystem] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const m = window.matchMedia("(prefers-color-scheme: dark)");
    const follow = () => setSystem(m.matches);
    m.addEventListener("change", follow);
    return () => m.removeEventListener("change", follow);
  }, []);
  const theme = choice === "auto" ? (system ? "dark" : "light") : choice;
  document.documentElement.classList.toggle("dark", theme === "dark");
  return theme;
}
