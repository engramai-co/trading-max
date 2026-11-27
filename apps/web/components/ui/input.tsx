import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"
import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "tm-field-control w-full min-w-0",
        className
      )}
      {...props}
    />
  )
}

export const identifierHints = { autoCapitalize: "none", autoCorrect: "off", spellCheck: false } as const

export { Input }
