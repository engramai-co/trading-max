import type { MetadataRoute } from "next";
import { brandColours, chartColours } from "@/ui/theme";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Trading Max",
    short_name: "Trading Max",
    description: "Portfolio analytics and investment research.",
    lang: "zh-CN",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: brandColours[0],
    theme_color: chartColours.text,
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/brand/trading-max-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/brand/trading-max-icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/brand/trading-max-icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
