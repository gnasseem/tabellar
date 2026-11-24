// The choice a decision is left as in a reply draft. Each answer is a
// paragraph that starts with its label in square brackets, a run of them is
// one choice, and the rest of the draft is said whichever is taken:
//
//   Hi Sam,
//
//   [Yes]
//   Thursday at 3 works for me.
//
//   [No]
//   I can't make Thursday at 3.
//
//   Best,
//   Maya
//
// Shared by the server and the interface. The labels count as gaps
// (policy.GAP), so a draft whose choice is open is never sent.

export type Choice = { label: string; text: string };
export type Block = { text: string } | { choice: Choice[] };

export const MARK = /^\s*[*_]{0,2}\[(\p{L}[^\]\n]{0,39}|\d[^\]\n]{0,39}\p{L}[^\]\n]{0,20})\][*_]{0,2}:?\s*/u;
const MOST_ANSWERS = 3;

// After a yes and a no, another label starts the next choice.
const YES = /^(?:yes|oui|s[ií]|ja|sim)\b/i;
const NO = /^(?:no|non|nein|nee|não)\b/i;
function isNext(choice: Choice[], label: string): boolean {
  return choice.some((c) => YES.test(c.label)) && choice.some((c) => NO.test(c.label)) && !YES.test(label) && !NO.test(label);
}

export function blocksOf(text: string): Block[] {
  const out: Block[] = [];
  for (const p of text.split(/\n[^\S\n]*\n\s*/).map((x) => x.trim()).filter(Boolean)) {
    const m = p.match(MARK);
    const before = out[out.length - 1];
    const bare = before && "choice" in before ? before.choice[before.choice.length - 1] : null;
    if (!m) {
      // A mail program may have put the label and its words in two paragraphs.
      if (bare && !bare.text) bare.text = p;
      else out.push({ text: p });
      continue;
    }
    const answer = { label: m[1].trim(), text: p.slice(m[0].length).trim() };
    const last = out[out.length - 1];
    const run = last && "choice" in last ? last.choice : null;
    // The same label again, with nothing said between, is another way to say it.
    if (run?.some((c) => c.label.toLowerCase() === answer.label.toLowerCase())) run.push({ ...answer, label: `${answer.label} 2` });
    else if (run && !isNext(run, answer.label)) run.push(answer);
    else out.push({ choice: [answer] });
  }
  return out;
}

const write = (blocks: Block[]) => blocks.map((b) => ("text" in b ? b.text : b.choice.map((c) => `[${c.label}]\n${c.text}`).join("\n\n"))).join("\n\n");

// The choices a draft leaves open; [] when it leaves none.
export const choicesOf = (text: string): Choice[][] => blocksOf(text).flatMap((b) => ("choice" in b && b.choice.length > 1 ? [b.choice] : []));

// In one line, for a list: "Yes: Thursday at 3 works for me. No: ...".
export const inLine = (text: string): string => (choicesOf(text).length ? text.replace(/\[([^\]\n]+)\]\s*\n/g, "$1: ") : text).replace(/\s+/g, " ").trim();

// What the draft says whichever answers are taken.
export const sharedText = (text: string): string => blocksOf(text).flatMap((b) => ("text" in b ? [b.text] : b.choice.length > 1 ? [] : [b.choice[0].text])).join("\n\n");

// The draft with an answer taken for each choice, by its place. One not taken
// (undefined) stays open.
export function choose(text: string, picks: (number | undefined)[]): string {
  let n = 0;
  return write(
    blocksOf(text).map((b) => {
      if ("text" in b || b.choice.length < 2) return b;
      const pick = picks[n++];
      return pick === undefined || !b.choice[pick] ? b : { text: b.choice[pick].text };
    }),
  );
}

// A model's draft in this form, whatever blank lines it left out: an answer is
// one paragraph, a sign-off run on under the last one is everyone's, one
// answer alone is no choice, and neither is the same answer twice. `none` is added to
// times that cannot all be declined.
export function tidyChoices(text: string, signoff: RegExp, none?: (choice: Choice[]) => Choice | null): string {
  const marks = text
    .replace(/\r/g, "")
    .replace(/\n[^\S\n]*(?=[*_]{0,2}\[\p{L}[^\]\n]{0,39}\])/gu, "\n\n")
    .replace(/(^|\n\n)([*_]{0,2}\[\p{L}[^\]\n]{0,39}\][*_]{0,2}:?)[^\S\n]*\n\s*(?![*_]{0,2}\[)/gu, "$1$2\n");
  const out: Block[] = [];
  for (const b of blocksOf(marks)) {
    if ("text" in b) {
      out.push(b);
      continue;
    }
    const choice: Choice[] = [];
    const after: string[] = [];
    for (const c of b.choice) {
      const lines = c.text.split("\n");
      const at = lines.findIndex((l, i) => i > 0 && signoff.test(l.trim()));
      const said = (at > 0 ? lines.slice(0, at) : lines).join("\n").trim();
      if (at > 0) after.push(lines.slice(at).join("\n"));
      const label = c.label.replace(/^\p{Ll}/u, (x) => x.toUpperCase());
      if (said && choice.length < MOST_ANSWERS && !choice.some((x) => x.text.toLowerCase() === said.toLowerCase())) choice.push({ label, text: said });
    }
    const more = choice.length > 1 && choice.length < MOST_ANSWERS ? none?.(choice) : null;
    if (more) choice.push(more);
    if (choice.length > 1) out.push({ choice });
    else if (choice.length) out.push({ text: choice[0].text });
    out.push(...after.map((t) => ({ text: t })));
  }
  return write(out);
}
