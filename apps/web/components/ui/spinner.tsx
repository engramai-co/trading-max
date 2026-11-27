import { cn } from "@/lib/utils"
import { Loader2Icon } from "lucide-react"

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <Loader2Icon size={16} data-slot="spinner" aria-hidden="true" className={cn("size-4 animate-spin shrink-0 motion-reduce:[animation-duration:6s]", className)} {...props} />
  )
}

export { Spinner }
