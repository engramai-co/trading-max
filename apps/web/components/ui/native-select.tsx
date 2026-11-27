import type * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

type NativeSelectProps = Omit<React.ComponentProps<"select">, "size">;

function NativeSelect({ className, ...props }: NativeSelectProps) {
  return (
    <div className={cn("tm-native-select", className)} data-slot="native-select-wrapper">
      <select data-slot="native-select" className="tm-field-control" {...props} />
      <ChevronDown size={16} aria-hidden="true" className="tm-picker-chevron" />
    </div>
  );
}

const NativeSelectOption = "option";

export { NativeSelect, NativeSelectOption };
