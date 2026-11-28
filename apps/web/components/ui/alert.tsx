import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

type AlertProps = ComponentProps<"div"> & { tone?: "neutral" | "good" | "warn" | "bad" };

export function Alert({ className, tone = "neutral", ...props }: AlertProps) {
  return <div data-slot="alert" role="alert" className={cn("mx-notice", `mx-notice-${tone}`, className)} {...props} />;
}
