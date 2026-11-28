"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

function Table({
  className,
  containerProps,
  label,
  caption,
  showCaption = false,
  pinFirst = true,
  pinFooter = false,
  stickyHeader = false,
  children,
  ...props
}: React.ComponentProps<"table"> & {
  containerProps?: Omit<React.ComponentProps<"div">, "ref"> & { ref?: React.RefCallback<HTMLDivElement> }
  label?: string
  caption?: React.ReactNode
  showCaption?: boolean
  pinFirst?: boolean
  pinFooter?: boolean
  stickyHeader?: boolean
}) {
  const { ref: containerRef, ...region } = containerProps ?? {}
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const tableRef = React.useRef<HTMLTableElement>(null)
  const setScrollRef = React.useCallback((element: HTMLDivElement | null) => {
    scrollRef.current = element
    return containerRef?.(element)
  }, [containerRef])

  React.useEffect(() => {
    const scrollport = scrollRef.current
    const table = tableRef.current
    if (!scrollport || !table || !label) return

    // Safari 16.4 has native sticky cells and scrolling. Its overlay scrollbar
    // can be hidden at rest, so keep the edge cues in sync there as well.
    const needsCueFallback = !CSS.supports("container-type", "scroll-state")
    function syncOverflow() {
      if (!scrollport) return
      const overflow = scrollport.scrollWidth - scrollport.clientWidth
      const canScroll = overflow > 1 || scrollport.scrollHeight - scrollport.clientHeight > 1
      if (region.tabIndex == null) {
        scrollport.tabIndex = canScroll || document.activeElement === scrollport ? 0 : -1
      }
      if (pinFooter) {
        scrollport.style.setProperty("--tm-table-inline-shift", scrollport.scrollLeft + "px")
      }
      if (needsCueFallback) {
        const offset = Math.abs(scrollport.scrollLeft)
        scrollport.toggleAttribute("data-more-start", offset > 1)
        scrollport.toggleAttribute("data-more-end", overflow - offset > 1)
      }
    }

    let focusFrame: number | undefined
    const revealFocusedCell = (event: FocusEvent) => {
      if (!(event.target instanceof HTMLElement)) return
      const control = event.target
      const cell = control.closest("td, th")
      const firstCell = cell?.parentElement?.firstElementChild
      if (!firstCell || firstCell === cell || firstCell.closest("table") !== table ||
          getComputedStyle(firstCell).position !== "sticky") return

      if (focusFrame !== undefined) cancelAnimationFrame(focusFrame)
      focusFrame = requestAnimationFrame(() => {
        if (document.activeElement !== control) return
        // Native focus scrolling cannot see the sibling painted over this cell.
        const frozen = firstCell.getBoundingClientRect()
        const focused = control.getBoundingClientRect()
        const rtl = getComputedStyle(scrollport).direction === "rtl"
        const adjustment = rtl
          ? Math.max(0, focused.right - frozen.left + 4)
          : Math.min(0, focused.left - frozen.right - 4)
        scrollport.scrollLeft += adjustment
      })
    }

    syncOverflow()
    const resize = new ResizeObserver(syncOverflow)
    resize.observe(scrollport)
    resize.observe(table)
    if (pinFirst) scrollport.addEventListener("focusin", revealFocusedCell)
    if (needsCueFallback || pinFooter) scrollport.addEventListener("scroll", syncOverflow, { passive: true })
    scrollport.addEventListener("blur", syncOverflow)
    return () => {
      resize.disconnect()
      scrollport.removeEventListener("scroll", syncOverflow)
      scrollport.removeEventListener("blur", syncOverflow)
      scrollport.removeEventListener("focusin", revealFocusedCell)
      if (focusFrame !== undefined) cancelAnimationFrame(focusFrame)
    }
  }, [label, pinFirst, pinFooter, region.tabIndex])

  React.useLayoutEffect(() => {
    const scrollport = scrollRef.current
    const footer = tableRef.current?.tFoot
    if (!pinFooter || !scrollport || !footer) return

    const valueText = document.createRange()
    const fitLabels = () => {
      const width = scrollport.clientWidth
      for (const row of footer.rows) {
        const heading = row.cells[0]
        const amount = row.cells[row.cells.length - 1]
        valueText.selectNodeContents(amount)
        const amountWidth = valueText.getBoundingClientRect().width
        const labelPadding = parseFloat(getComputedStyle(heading).paddingInlineStart)
        const amountPadding = parseFloat(getComputedStyle(amount).paddingInlineEnd)
        // Leave room for the amount when it reaches the far edge of the scrollport.
        row.style.setProperty("--tm-table-footer-label-width",
          Math.max(0, width - amountWidth - labelPadding - amountPadding - 8) + "px")
      }
    }
    const resize = new ResizeObserver(fitLabels)
    resize.observe(scrollport)
    resize.observe(footer)
    fitLabels()
    return () => resize.disconnect()
  }, [pinFooter, children])

  React.useEffect(() => {
    const scrollport = scrollRef.current
    const header = tableRef.current?.tHead
    if (!stickyHeader || !scrollport || !header) return

    // The horizontal scroller is the header's nearest scroll container.
    // Translate the native header within this table as the page scrolls.
    let frame: number | undefined
    const update = () => {
      frame = undefined
      const bounds = scrollport.getBoundingClientRect()
      const headerHeight = header.offsetHeight
      scrollport.style.setProperty("--tm-table-page-offset", -bounds.top + "px")
      scrollport.style.setProperty("--tm-table-header-travel", Math.max(0, bounds.height - headerHeight) + "px")
      scrollport.style.setProperty("--tm-table-header-size", headerHeight + "px")
    }
    const schedule = () => {
      if (frame === undefined) frame = requestAnimationFrame(update)
    }
    const resize = new ResizeObserver(schedule)
    resize.observe(scrollport)
    resize.observe(header)
    window.addEventListener("scroll", schedule, { passive: true, capture: true })
    window.addEventListener("resize", schedule, { passive: true })
    update()
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      resize.disconnect()
      window.removeEventListener("scroll", schedule, true)
      window.removeEventListener("resize", schedule)
    }
  }, [stickyHeader])

  return (
    <div
      data-slot="table-container"
      data-pin-first={pinFirst || undefined}
      data-sticky-header={stickyHeader || undefined}
      role={label ? "region" : undefined}
      aria-label={label}
      {...region}
      ref={setScrollRef}
      className={cn("tm-table-scrollport", region.className)}
    >
      <table
        data-slot="table"
        className={className}
        ref={tableRef}
        {...props}
      >
        {label && <TableCaption className={showCaption ? "mx-table-caption" : "sr-only"}>
          {caption ?? label}
        </TableCaption>}
        {children}
      </table>
    </div>
  )
}

function TableHeader(props: React.ComponentProps<"thead">) {
  return <thead data-slot="table-header" {...props} />
}

function TableBody(props: React.ComponentProps<"tbody">) {
  return <tbody data-slot="table-body" {...props} />
}

function TableFooter(props: React.ComponentProps<"tfoot">) {
  return <tfoot data-slot="table-footer" {...props} />
}

function TableRow(props: React.ComponentProps<"tr">) {
  return <tr data-slot="table-row" {...props} />
}

function TableHead(props: React.ComponentProps<"th">) {
  return <th data-slot="table-head" {...props} />
}

function TableCell(props: React.ComponentProps<"td">) {
  return <td data-slot="table-cell" {...props} />
}

function TableCaption(props: React.ComponentProps<"caption">) {
  return <caption data-slot="table-caption" {...props} />
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
