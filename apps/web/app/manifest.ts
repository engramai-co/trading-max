import type { MetadataRoute } from "next";
import { brandColours, chartColours } from "@/ui/theme";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Trading Max",
    short_name: "Trading Max",
    description: "Local-first portfolio intelligence and investment research.",
    start_url: "/",
    display: "standalone",
    background_color: brandColours[0],
    theme_color: chartColours.text,
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
  };
}
