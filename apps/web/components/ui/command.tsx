"use client"

import type { ComponentProps } from "react"
import { Command as CommandPrimitive } from "cmdk"
import { SearchIcon } from "lucide-react"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"

function Command(props: ComponentProps<typeof CommandPrimitive>) {
  return <CommandPrimitive data-slot="command" {...props} />
}

function CommandInput(props: ComponentProps<typeof InputGroupInput>) {
  // The caller owns both filtering and the active result. Keep cmdk's internal
  // query empty so its search effect cannot select the first row again.
  return (
    <InputGroup>
      <InputGroupAddon aria-hidden="true"><SearchIcon size={20} /></InputGroupAddon>
      <CommandPrimitive.Input asChild value="">
        <InputGroupInput {...props} />
      </CommandPrimitive.Input>
    </InputGroup>
  )
}

// cmdk calls the List slot component to insert its measuring wrapper.
function ListContainer(props: ComponentProps<"div">) {
  return <div {...props} />
}

function CommandList({ children, ...props }: Omit<ComponentProps<typeof CommandPrimitive.List>, "asChild">) {
  return (
    <CommandPrimitive.List data-slot="command-list" asChild {...props}>
      {/* The input retains focus and supplies the active descendant. */}
      <ListContainer aria-activedescendant={undefined}>{children}</ListContainer>
    </CommandPrimitive.List>
  )
}

function CommandGroup(props: ComponentProps<typeof CommandPrimitive.Group>) {
  return <CommandPrimitive.Group data-slot="command-group" {...props} />
}

function CommandItem(props: ComponentProps<typeof CommandPrimitive.Item>) {
  return <CommandPrimitive.Item data-slot="command-item" {...props} />
}

export { Command, CommandGroup, CommandInput, CommandItem, CommandList }
