"use client";

import { Toast as ToastPrimitive } from "@base-ui/react/toast";
import { useLocale } from "@/components/locale-provider";
import { CloseButton } from "./button";

function ToastList() {
  const { locale } = useLocale();
  const { toasts } = ToastPrimitive.useToastManager();
  return toasts.map((toast) => (
    <ToastPrimitive.Root toast={toast} key={toast.id} data-slot="toast" swipeDirection={["up", "right"]}>
      <ToastPrimitive.Content className="flex items-start gap-3 p-4">
        <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          <ToastPrimitive.Title className="text-sm font-semibold" />
          <ToastPrimitive.Description className="text-sm text-muted-foreground" />
        </div>
        <ToastPrimitive.Close
          render={<CloseButton aria-label={locale === "zh" ? "关闭通知" : "Dismiss notification"} />}
        />
      </ToastPrimitive.Content>
    </ToastPrimitive.Root>
  ));
}

/** Optional feedback for user actions. Workspace status and recovery belong beside the affected content. */
export function Toaster({ children }: { children: React.ReactNode }) {
  const { locale } = useLocale();
  return (
    <ToastPrimitive.Provider timeout={0}>
      {children}
      <ToastPrimitive.Portal>
        <ToastPrimitive.Viewport data-slot="toast-viewport" aria-label={locale === "zh" ? "通知" : "Notifications"}>
          <ToastList />
        </ToastPrimitive.Viewport>
      </ToastPrimitive.Portal>
    </ToastPrimitive.Provider>
  );
}

export const useToastManager = ToastPrimitive.useToastManager;
