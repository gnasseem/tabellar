/** @type {import('tailwindcss').Config} */
// Every colour is a token from src/index.css, so the same class works in light and dark.
const token = (name) => ({ opacityValue }) =>
  opacityValue === undefined ? `var(--${name})` : `color-mix(in oklch, var(--${name}) calc(${opacityValue} * 100%), transparent)`;

module.exports = {
  content: [
    "./index.html",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/*.{ts,tsx}",
    "./src/lib/**/*.{ts,tsx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        canvas: token("bg"), side: token("side"), raised: token("raised"),
        hover: token("hover"), sel: token("sel"), field: token("field"),
        line: token("line"), "line-soft": token("line-soft"),
        ink: token("ink"), ink2: token("ink2"), ink3: token("ink3"), ink4: token("ink4"),
        wax: token("wax"), "wax-ink": token("wax-ink"), "wax-soft": token("wax-soft"), "on-wax": token("on-wax"),
        warn: token("warn"), "warn-soft": token("warn-soft"), "warn-line": token("warn-line"),
        danger: token("danger"), "danger-soft": token("danger-soft"), "danger-line": token("danger-line"),
        ok: token("ok"), "ok-soft": token("ok-soft"), "ok-line": token("ok-line"),
      },
      fontFamily: {
        sans: ["system-ui", "-apple-system", '"SF Pro Text"', '"Helvetica Neue"', "sans-serif"],
        brand: ['"Ysabeau Office"', "system-ui", "sans-serif"],
      },
      fontSize: { base: ["13px", "1.4"] },
      boxShadow: {
        control: "var(--shadow-control)",
        pop: "var(--shadow-pop)",
      },
    },
  },
  plugins: [],
};
