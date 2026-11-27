"use client";

import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { identifierHints, Input } from "./input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./input-group";

export const searchInputHints = { ...identifierHints, type: "search", autoComplete: "off", enterKeyHint: "search" } as const;

export function SearchInput({
  className, leading, trailing, ...props
}: ComponentProps<typeof Input> & { leading?: ReactNode; trailing?: ReactNode }) {
  return (
    <div role="search" aria-label={props["aria-label"]} className={cn("min-w-0", className)}>
      {leading || trailing ? (
        <InputGroup>
          {leading && <InputGroupAddon aria-hidden="true">{leading}</InputGroupAddon>}
          <InputGroupInput {...searchInputHints} {...props} />
          {trailing && <InputGroupAddon align="inline-end">{trailing}</InputGroupAddon>}
        </InputGroup>
      ) : <Input {...searchInputHints} {...props} />}
    </div>
  );
}
