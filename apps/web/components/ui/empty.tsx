import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

function Empty({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="empty" className={cn("mx-empty min-w-0", className)} {...props} />;
}

function EmptyTitle({ as: Heading = "h3", ...props }: ComponentProps<"h3"> & { as?: "h2" | "h3" }) {
  return <Heading data-slot="empty-title" {...props} />;
}

function EmptyDescription(props: ComponentProps<"p">) {
  return <p data-slot="empty-description" {...props} />;
}

export { Empty, EmptyTitle, EmptyDescription };
