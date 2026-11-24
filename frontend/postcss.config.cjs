// The text size setting changes the root font size (src/lib/appearance.ts),
// and everything written in rem follows it. Lengths are written in px in the
// classes and in index.css, as they are at the default size, and turned into
// rem here. Hairlines, outlines and shadows stay in px.
const pxToRem = {
  postcssPlugin: "px-to-rem",
  Declaration(decl) {
    if (!decl.value.includes("px") || /border(?!-radius)|outline|shadow|^stroke/.test(decl.prop)) return;
    decl.value = decl.value.replace(/(^|[\s(,+*/-])(-?\d*\.?\d+)px/g, (all, before, n) => (Math.abs(n) > 2 ? `${before}${n / 16}rem` : all));
  },
};

module.exports = {
  plugins: [require("tailwindcss"), require("autoprefixer"), pxToRem],
};
