// The three pages of Tabellar+: what it is and paying, after paying, and the
// plain one. Colours are the app's.

const STYLE = `:root{--bg:#fff;--ink:#23211f;--ink2:#57534f;--line:#e6e3df;--wax:#a33a24}
@media(prefers-color-scheme:dark){:root{--bg:#1d1b1a;--ink:#efece8;--ink2:#b9b4ae;--line:#3a3735;--wax:#e58a72}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink2);font:16px/1.6 system-ui,-apple-system,sans-serif}main{max-width:44rem;margin:0 auto;padding:4rem 1.25rem}
h1{color:var(--ink);font-size:1.9rem;line-height:1.2;margin:0 0 .75rem}h2{color:var(--ink);font-size:1.1rem;margin:0}a{color:var(--wax)}
.plans{display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));margin:2rem 0}.plan{border:1px solid var(--line);border-radius:14px;padding:1.25rem}.price{color:var(--ink);font-size:1.5rem;font-weight:650}
button,.go{display:inline-block;font:inherit;font-weight:600;border:0;border-radius:10px;padding:.6rem 1.1rem;background:var(--wax);color:var(--bg);cursor:pointer;text-decoration:none}button:disabled{opacity:.5;cursor:default}
code{display:block;padding:.75rem;border:1px solid var(--line);border-radius:10px;overflow-wrap:anywhere;color:var(--ink);user-select:all}.small{font-size:.875rem}`;

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

export function checkoutPage(o: { open: boolean; full: boolean; token: string; sandbox: boolean; plus: string; always: string }): string {
  const buy = (plan: string, price: string, closed: boolean) => (o.open && o.token && price && !closed ? `<button data-price="${price}">Choose ${plan}</button>` : `<button disabled>${closed ? "Full for now" : "By invitation for now"}</button>`);
  return page(
    "Tabellar+",
    `<h1>Tabellar+</h1><p>Tabellar is free, and all of it stays free. Tabellar+ is for what needs someone else's computer.</p>
<div class="plans">
<div class="plan"><h2>Plus</h2><p>Tabellar on your own computer, with the AI included. No API key. Your mail goes from your computer to the model, at companies that keep none of it, and not through us.</p>${buy("Plus", o.plus, false)}</div>
<div class="plan"><h2>Always on</h2><p>A server of your own that works with your computer off, opened from any browser with a passkey, with the AI included. For Outlook, iCloud, Fastmail, Yahoo, and Gmail with an app password.</p>${buy("Always on", o.always, o.full)}</div>
</div>
<p class="small">Always on keeps your mail on a server we look after, on an encrypted disk, backed up for 14 days. We do not read it, but nothing technical would stop whoever looks after that server. When you leave, the server stays 30 days so you can move out, then it is deleted, and its backups within 14 days.</p>
<p class="small"><a href="https://github.com/gnasseem/tabellar">Tabellar is open source.</a></p>
${
  o.open && o.token
    ? `<script src="https://cdn.paddle.com/paddle/v2/paddle.js"></script><script>
${o.sandbox ? 'Paddle.Environment.set("sandbox");' : ""}Paddle.Initialize({ token: ${JSON.stringify(o.token)} });
const b64 = (b) => btoa(String.fromCharCode(...b)).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
for (const b of document.querySelectorAll("[data-price]")) b.onclick = async () => {
  // The code is made here and only its hash is sent with the payment.
  const code = b64(crypto.getRandomValues(new Uint8Array(32)));
  const sum = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code)));
  try { localStorage.setItem("tabellar-code", code); } catch {}
  Paddle.Checkout.open({ items: [{ priceId: b.dataset.price, quantity: 1 }], customData: { code_hash: [...sum].map((x) => x.toString(16).padStart(2, "0")).join("") }, settings: { successUrl: location.origin + "/start#" + code } });
};
</script>`
    : ""
}`,
  );
}

export function startPage(nonce: string): string {
  return page(
    "Tabellar+",
    `<h1 id="title">One moment</h1><div id="body"></div>
<script nonce="${nonce}">
let code = location.hash.slice(1);
try { code = code || localStorage.getItem("tabellar-code") || ""; } catch {}
const title = document.getElementById("title"), body = document.getElementById("body");
const add = (tag, text, more) => body.appendChild(Object.assign(document.createElement(tag), { textContent: text }, more));
const show = (t) => { title.textContent = t; body.replaceChildren(); };
const look = async (n) => {
  const r = await fetch("/api/status", { method: "POST", body: JSON.stringify({ code }) }).catch(() => null);
  const s = r ? await r.json().catch(() => ({})) : {};
  if (!r || !r.ok) {
    if (code && n < 40) return setTimeout(look, 3000, n + 1);
    show("No subscription found");
    return add("p", "If you have just paid, wait a minute and reload this page. Otherwise open the link you were given.");
  }
  if (s.status !== "active") { show("This subscription has ended"); return s.plan === "always" ? add("p", "Your server is deleted after " + new Date(s.ends_at).toLocaleDateString() + ".") : undefined; }
  if (s.plan === "always" && !s.link) { show("Making your server"); add("p", "This takes a minute or two."); return setTimeout(look, 3000, 0); }
  show("Ready");
  if (s.plan === "always") {
    add("p", "Open it and make a passkey. Keep the address: it is yours.");
    add("p", "").appendChild(Object.assign(document.createElement("a"), { className: "go", href: s.link, textContent: "Open my Tabellar" }));
  } else add("p", "In Tabellar, choose Tabellar+ under Settings, Models, Cloud, and paste this code.");
  add("p", "Your code. Keep it somewhere safe, like a password:");
  add("code", code);
};
look(0);
</script>`,
  );
}
