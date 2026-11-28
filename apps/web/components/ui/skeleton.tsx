import { cn } from "@/lib/utils"

function Skeleton({ as: Element = "div", className, ...props }: React.ComponentProps<"div"> & { as?: "div" | "span" }) {
  return (
    <Element
      data-slot="skeleton"
      aria-hidden="true"
      className={cn(className)}
      {...props}
    />
  )
}

export { Skeleton }
