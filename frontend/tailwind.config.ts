import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        "bg-base": "#14171C",
        "bg-surface": "#1C2027",
        border: "#2A2F38",
        "text-primary": "#E4E6EA",
        "text-secondary": "#9AA1AC",
        "text-muted": "#8C8C8C",
        accent: "#3E9C8A",
        light: {
          "bg-base": "#F5F4F0",
          "bg-surface": "#FFFFFF",
          border: "#E2E0DA",
          "text-primary": "#1F2328",
          "text-secondary": "#5B6169",
          accent: "#0F6E56",
        },
        severity: {
          normal: "#4C9A6A",
          low: "#4C9A6A",
          medium: "#C79A45",
          high: "#C67C4E",
          critical: "#C3645A",
        },
      },
      fontFamily: {
        ui: ["var(--font-inter)", "sans-serif"],
        data: ["var(--font-jetbrains-mono)", "monospace"],
      },
      fontSize: {
        meta: ["12px", { lineHeight: "16px" }],
        body: ["14px", { lineHeight: "20px" }],
        section: ["16px", { lineHeight: "24px" }],
        heading: ["22px", { lineHeight: "32px" }],
      },
      spacing: {
        1: "4px",
        2: "8px",
        3: "12px",
        4: "16px",
        6: "24px",
        8: "32px",
        12: "48px",
      },
      borderRadius: {
        control: "6px",
        panel: "12px",
      },
      screens: {
        md: "768px",
      },
    },
  },
  plugins: [],
};

export default config;

