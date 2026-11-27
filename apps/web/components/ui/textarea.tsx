"use client"

import * as React from "react"
import TextareaAutosize from "react-textarea-autosize"
import { cn } from "@/lib/utils"

type TextareaProps = React.ComponentProps<"textarea"> & {
  minRows?: number
  maxRows?: number
}

function Textarea({ className, minRows, maxRows, style, ...props }: TextareaProps) {
  const controlClassName = cn("tm-field-control w-full min-w-0", className)
  if (minRows !== undefined) {
    const autosizeStyle = style && { ...style, height: undefined };
    return <TextareaAutosize data-slot="textarea" className={controlClassName} style={autosizeStyle} minRows={minRows} maxRows={maxRows} {...props} />
  }
  return (
    <textarea
      data-slot="textarea"
      className={controlClassName}
      style={style}
      {...props}
    />
  )
}

export { Textarea }
