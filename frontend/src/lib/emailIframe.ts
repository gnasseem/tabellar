// Default colours for an email shown in an iframe, as a style block to put
// ahead of the email's own markup. The frame cannot see the window's tokens,
// so their current values are read from the page. The rules have no
// specificity and sit on the root, so an email that sets its own background,
// text or link colour keeps it.
export function emailFrameThemeCss(): string {
  const cs = getComputedStyle(document.documentElement);
  const token = (name: string) => cs.getPropertyValue(name).trim();
  return (
    `<style>:where(html){color-scheme:${cs.colorScheme || "light"};background:${token("--bg")};color:${token("--ink")}}` +
    `:where(a){color:${token("--ink")};text-decoration-color:${token("--ink4")};text-underline-offset:2px}</style>`
  );
}

function isFullBleedOverlay(el: HTMLElement, doc: Document): boolean {
  const st = getComputedStyle(el);
  if (st.position !== "fixed" && st.position !== "absolute") return false;
  const vw = doc.documentElement.clientWidth;
  const vh = doc.documentElement.clientHeight;
  if (vh < 64 || vw < 64) return false;
  const r = el.getBoundingClientRect();
  return r.width >= vw * 0.88 && r.height >= vh * 0.82;
}

/** Layout height for HTML bodies where scrollHeight is inflated by full-viewport wrappers. */
export function measureIntrinsicEmailBodyHeight(body: HTMLElement): number {
  const doc = body.ownerDocument;
  const bodyTop = body.getBoundingClientRect().top;
  let maxBottom = 0;
  const els = body.querySelectorAll("*");
  for (let i = 0; i < els.length; i++) {
    const el = els[i] as HTMLElement;
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden") continue;
    if (isFullBleedOverlay(el, doc)) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) continue;
    maxBottom = Math.max(maxBottom, r.bottom - bodyTop);
  }
  if (maxBottom < 12 && (body.textContent || "").trim().length > 0) {
    const doc = body.ownerDocument;
    const range = doc.createRange();
    range.selectNodeContents(body);
    const br = range.getBoundingClientRect();
    maxBottom = Math.max(maxBottom, br.bottom - bodyTop);
  }
  const cs = getComputedStyle(body);
  const padY =
    (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  return Math.ceil(Math.max(maxBottom + padY, 28));
}

export function measureEmailIframeBodyHeight(body: HTMLElement): number {
  const intrinsic = measureIntrinsicEmailBodyHeight(body);
  const scrollH = Math.max(body.scrollHeight, body.offsetHeight);
  const minTrust = Math.max(96, scrollH * 0.12);
  const looksInflated =
    intrinsic >= 40 && scrollH > intrinsic * 1.28 && scrollH > intrinsic + 120;
  const useIntrinsic = looksInflated && intrinsic >= minTrust;
  const h = useIntrinsic ? intrinsic : Math.max(intrinsic, scrollH);
  return Math.max(48, Math.min(Math.ceil(h + 10), 200_000));
}
