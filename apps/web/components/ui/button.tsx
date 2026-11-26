"use client";

import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { LoaderCircle, X } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  [
    "group/button relative inline-flex shrink-0 items-center justify-center appearance-none no-underline",
    "rounded-full border border-transparent bg-clip-padding text-sm font-medium leading-snug whitespace-nowrap select-none cursor-pointer",
    "motion-safe:transition-[background-color,border-color,color,scale] motion-reduce:transition-[background-color,border-color,color] duration-[120ms] ease-[cubic-bezier(0.2,0,0,1)]",
    "motion-safe:[&:not(:disabled):not([aria-disabled='true'])]:active:scale-[0.98]",
    "outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring forced-colors:focus-visible:outline-[Highlight]",
    "disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ].join(" "),
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground [&:not(:disabled):not([aria-disabled='true'])]:hover:bg-[var(--primary-hover)] [&:not(:disabled):not([aria-disabled='true'])]:active:bg-[var(--primary-active)]",
        secondary:
          "bg-secondary text-secondary-foreground [&:not(:disabled):not([aria-disabled='true'])]:hover:bg-[var(--secondary-hover)] [&:not(:disabled):not([aria-disabled='true'])]:active:bg-[var(--secondary-active)] aria-expanded:bg-[var(--secondary-hover)]",
        outline:
          "border-border-strong bg-transparent text-foreground [&:not(:disabled):not([aria-disabled='true'])]:hover:bg-[var(--ghost-hover)] [&:not(:disabled):not([aria-disabled='true'])]:active:bg-[var(--ghost-active)] aria-expanded:bg-[var(--ghost-hover)]",
        ghost:
          "bg-transparent text-foreground [&:not(:disabled):not([aria-disabled='true'])]:hover:bg-[var(--ghost-hover)] [&:not(:disabled):not([aria-disabled='true'])]:active:bg-[var(--ghost-active)] aria-expanded:bg-[var(--ghost-hover)]",
        link:
          "bg-transparent text-link underline-offset-4 [&:not(:disabled):not([aria-disabled='true'])]:hover:underline",
        destructive:
          "border-destructive bg-transparent text-destructive [&:not(:disabled):not([aria-disabled='true'])]:hover:bg-[var(--destructive-hover)] [&:not(:disabled):not([aria-disabled='true'])]:active:bg-[var(--destructive-active)] [&:not(:disabled):not([aria-disabled='true'])]:active:text-[var(--destructive-active-ink)]",
      },
      size: {
        default: "min-h-10 gap-2 px-4 py-2 pointer-coarse:min-h-11",
        table: "min-h-8 gap-1.5 px-3 py-1 text-xs pointer-coarse:min-h-11",
        icon: "size-10 min-w-10 min-h-10 p-0 pointer-coarse:size-11 pointer-coarse:min-w-11 pointer-coarse:min-h-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends Omit<ButtonPrimitive.Props, "children">,
    VariantProps<typeof buttonVariants> {
  children?: React.ReactNode;
  loading?: boolean;
  /** Optional replacement text shown beside the spinner while loading, width-reserved up front. */
  loadingLabel?: React.ReactNode;
  fullWidth?: boolean;
}

const Button = React.forwardRef<HTMLElement, ButtonProps>(function Button(
  {
    className,
    variant = "default",
    size = "default",
    loading,
    loadingLabel,
    fullWidth = false,
    disabled,
    focusableWhenDisabled,
    children,
    "aria-busy": ariaBusy,
    ...props
  },
  ref,
) {
  const isLoading = Boolean(loading);
  const isDisabled = Boolean(disabled || isLoading);
  const keepFocus = focusableWhenDisabled ?? (isLoading && !disabled);
  const gapClass = size === "table" ? "gap-1.5" : "gap-2";
  const reserveGrid = loading !== undefined || loadingLabel !== undefined;
  const activeLoadingLabel = loadingLabel ?? children;

  return (
    <ButtonPrimitive
      ref={ref}
      data-slot="button"
      data-variant={variant}
      data-size={size}
      data-loading={isLoading ? "" : undefined}
      disabled={isDisabled}
      focusableWhenDisabled={isDisabled ? keepFocus : false}
      aria-busy={ariaBusy ?? (isLoading ? true : undefined)}
      className={cn(
        buttonVariants({ variant, size }),
        fullWidth && "w-full",
        className,
      )}
      {...props}
    >
      {reserveGrid ? (
        <span className="inline-grid place-items-center">
          <span
            className={cn(
              "col-start-1 row-start-1 inline-flex items-center justify-center",
              gapClass,
              isLoading && "invisible opacity-0 pointer-events-none select-none",
            )}
            aria-hidden={isLoading ? true : undefined}
          >
            {children}
          </span>
          <span
            className={cn(
              "col-start-1 row-start-1 inline-flex items-center justify-center",
              gapClass,
              !isLoading && "invisible opacity-0 pointer-events-none select-none",
            )}
            aria-hidden={!isLoading ? true : undefined}
          >
            {isLoading ? (
              <LoaderCircle
                data-slot="button-spinner"
                className="size-4 animate-spin"
                aria-hidden="true"
              />
            ) : (
              <span
                data-slot="button-spinner-placeholder"
                className="size-4 shrink-0"
                aria-hidden="true"
              />
            )}
            {activeLoadingLabel}
          </span>
        </span>
      ) : (
        children
      )}
    </ButtonPrimitive>
  );
});

export interface CloseButtonProps
  extends Omit<ButtonProps, "children" | "variant" | "size" | "loading" | "loadingLabel"> {
  "aria-label": string;
  iconSize?: number;
}

const CloseButton = React.forwardRef<HTMLElement, CloseButtonProps>(
  function CloseButton({ iconSize = 16, className, ...props }, ref) {
    return (
      <Button
        ref={ref}
        variant="ghost"
        size="icon"
        className={cn("text-muted-foreground hover:text-foreground", className)}
        {...props}
      >
        <X size={iconSize} strokeWidth={1.75} aria-hidden="true" />
      </Button>
    );
  },
);

export { Button, CloseButton, buttonVariants };
