// Settings, Writing: how the user writes, learned from their sent mail and
// edited here, for everyone and per kind of recipient; the phrases and rules
// every draft keeps to; and a sample reply (server/writing.ts).
import { useCallback, useContext, useEffect, useState } from "react";
import Icon from "@/components/Icon";
import { createClient } from "@/lib/db";
import { api } from "@/lib/outcomes";
import { useApp } from "../AppShell";
import { Seg } from "../ui";
import { AddButton, Group, LineField, Lines, loadingLines, Row, Saved } from "./parts";

const supabase = createClient();

type Kind = "all" | "org" | "known" | "stranger";
type Field = "greeting_style" | "closing_style" | "tone" | "avg_length";
type Style = Partial<Record<Field, string | null>> & { kinds: Partial<Record<Kind, Partial<Record<Field, string>>>>; avoid: string[]; edited: string[]; edits: unknown[]; sample_count: number; last_learned_at: string | null };
type Rule = { id: string; value: string; source: string; evidence: string | null };
type Sample = { who: string; subject: string; text: string; example: boolean; draft: string };

const KINDS: { id: Kind; label: string }[] = [
  { id: "all", label: "Everyone" },
  { id: "org", label: "Your organisation" },
  { id: "known", label: "People you know" },
  { id: "stranger", label: "Strangers" },
];
const LENGTHS = [
  { id: "short", label: "Short, under 60 words" },
  { id: "medium", label: "Medium, 60 to 150 words" },
  { id: "long", label: "Long, over 150 words" },
];

export default function Writing() {
  const { user, addToast, liveChanges } = useApp();
  const flash = useContext(Saved);
  const [style, setStyle] = useState<Style | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [kind, setKind] = useState<Kind>("all");
  const [learning, setLearning] = useState(false);
  const [addingRule, setAddingRule] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [sample, setSample] = useState<Sample | null>(null);
  const [writing, setWriting] = useState(false);

  const load = useCallback(async () => {
    const [{ data: s }, { data: r }] = await Promise.all([
      supabase.from("style_profiles").select("*").eq("user_id", user.id).maybeSingle(),
      supabase.from("preferences").select("id, value, source, evidence").eq("user_id", user.id).eq("kind", "writing").order("created_at", { ascending: true }),
    ]);
    setStyle({ kinds: {}, avoid: [], edited: [], edits: [], sample_count: 0, last_learned_at: null, ...((s as Partial<Style> | null) ?? {}) });
    setRules((r as Rule[]) ?? []);
  }, [user.id]);
  useEffect(() => {
    load();
  }, [load, liveChanges.emails]);

  const run = async (work: () => Promise<unknown>) => {
    try {
      await work();
      flash();
    } catch (e) {
      addToast("error", (e as Error).message);
    }
    load();
  };
  const set = (field: Field, value: string) => run(() => api("/writing/line", { kind, field, value }));
  const setAvoid = (phrases: string[]) => {
    setStyle((s) => s && { ...s, avoid: phrases });
    return run(() => api("/writing/avoid", { phrases }));
  };
  const learn = async () => {
    setLearning(true);
    await run(() => api("/writing/learn", {}));
    setLearning(false);
  };
  const tryIt = async () => {
    setWriting(true);
    try {
      setSample(await api("/writing/sample", { kind }));
    } catch (e) {
      addToast("error", `No reply was written. ${(e as Error).message === "LLM_API_ERROR" ? "The model answered with an error." : (e as Error).message}`);
    }
    setWriting(false);
  };

  if (!style) return loadingLines;
  const own = (f: Field) => (kind === "all" ? style[f] : style.kinds[kind]?.[f]) || "";
  const base = (f: Field) => style[f] || "";
  const hint = (f: Field, such: string) => (kind === "all" ? such : base(f) ? base(f).replace("\n", ", ").replace(/,,/g, ",") : such);
  const mark = (f: Field) => (style.edited.includes(`${kind}.${f}`) && own(f) ? "You set this" : kind !== "all" && !own(f) ? "As for everyone" : undefined);
  const note = [
    style.last_learned_at ? `Learned from ${style.sample_count.toLocaleString()} sent emails on ${new Date(style.last_learned_at).toLocaleDateString([], { day: "numeric", month: "long" })}${style.edits.length ? " and from your changes to drafts since" : ""}.` : "",
    "{name} stands for the person's name; None leaves the line out.",
  ];

  return (
    <>
      <Group
        title="How you write"
        right={
          <button className="btn btn-sm" onClick={learn} disabled={learning}>
            {learning ? "Reading sent mail" : style.last_learned_at ? "Learn again" : "Learn from sent mail"}
          </button>
        }
        note={note.filter(Boolean).join(" ")}
      >
        <div className="-ml-2 py-1.5">
          <Seg<Kind> value={kind} onChange={setKind} options={KINDS} />
        </div>
        <Row name="Greeting" text={mark("greeting_style")}>
          <LineField key={`${kind}g`} className="!w-[260px]" label="Greeting" value={own("greeting_style")} onSave={(v) => set("greeting_style", v)} placeholder={hint("greeting_style", "Such as Hi {name},")} />
        </Row>
        <Row name="Sign-off" text={mark("closing_style")}>
          <LineField key={`${kind}c`} rows={2} className="!w-[260px]" label="Sign-off" value={own("closing_style")} onSave={(v) => set("closing_style", v)} placeholder={hint("closing_style", "Such as Best,")} />
        </Row>
        <Row name="Tone" text={mark("tone")}>
          <LineField key={`${kind}t`} className="!w-[260px]" label="Tone" value={own("tone")} onSave={(v) => set("tone", v)} placeholder={hint("tone", "Such as warm and direct")} />
        </Row>
        <Row name="Length" text={mark("avg_length")}>
          <select className="input !w-[260px]" aria-label="Length" value={own("avg_length")} onChange={(e) => set("avg_length", e.target.value)}>
            <option value="">{kind === "all" ? "Not set" : LENGTHS.find((l) => l.id === base("avg_length"))?.label || "As for everyone"}</option>
            {LENGTHS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </Row>
      </Group>

      <Group title="Rules" right={<AddButton onClick={() => setAddingRule(true)} />}>
        <Lines
          label="Rule"
          placeholder="Never open with I hope this finds you well"
          lines={rules.map((r) => ({ id: r.id, text: r.value, right: r.evidence ? "From a draft" : undefined, title: r.evidence ?? undefined }))}
          adding={addingRule}
          setAdding={setAddingRule}
          onSave={(text, replace) => run(() => api("/preferences", { kind: "writing", subject: "", value: text, replace }))}
          onDelete={(id) => run(async () => void (await supabase.from("preferences").delete().eq("id", id)))}
        />
      </Group>

      <Group title="Phrases to avoid" note={style.avoid.length ? "Also in other words: a draft that says one is written again without it." : undefined}>
        <div className="flex flex-wrap items-center gap-1.5 py-2.5">
          {style.avoid.map((p) => (
            <span key={p} className="flex min-h-6 items-center gap-1 rounded-md bg-field py-0.5 pl-2 pr-1 text-[12.5px] text-ink">
              {p}
              <button type="button" className="grid h-4 w-4 place-items-center rounded text-ink3 hover:text-ink" aria-label={`Remove ${p}`} onClick={() => setAvoid(style.avoid.filter((x) => x !== p))}>
                <Icon name="close" size={11} />
              </button>
            </span>
          ))}
          <form
            className="flex min-w-[220px] flex-1 items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (!phrase.trim()) return;
              setAvoid([...style.avoid, phrase.trim()]);
              setPhrase("");
            }}
          >
            <input className="input !h-6 !px-2 !text-[12.5px]" value={phrase} onChange={(e) => setPhrase(e.target.value)} placeholder="Add a phrase" aria-label="Phrase to avoid" />
            {phrase.trim() && (
              <button className="btn btn-sm" type="submit">
                Add
              </button>
            )}
          </form>
        </div>
      </Group>

      <Group
        title="Sample reply"
        right={
          <button className="btn btn-sm" onClick={tryIt} disabled={writing}>
            {writing ? "Writing" : sample ? "Write another" : "Write a sample reply"}
          </button>
        }
        note="Kept nowhere and sent to nobody."
      >
        {writing ? (
          loadingLines
        ) : sample ? (
          <div className="py-3">
            <p className="text-ink">
              <span className="font-medium">{sample.who}</span>
              <span className="text-ink3">
                {" "}
                {sample.example ? "(made up) wrote" : "wrote"}, {sample.subject || "(no subject)"}
              </span>
            </p>
            <p className="mt-1 line-clamp-3 whitespace-pre-line text-[12.5px] leading-normal text-ink2">{sample.text.replace(/\n{2,}/g, "\n")}</p>
            <p className="inset mt-3 whitespace-pre-wrap leading-[1.6] text-ink">{sample.draft}</p>
          </div>
        ) : (
          <p className="py-3 text-ink3">A reply to a recent email from {kind === "all" ? "anyone" : { org: "your organisation", known: "someone you know", stranger: "a stranger" }[kind]}</p>
        )}
      </Group>
    </>
  );
}
