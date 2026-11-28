"use client";

import { useLocale } from "@/components/locale-provider";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadingStatus, useCopy } from "./foundation";

type SettingsSection = "accounts" | "models" | "assistant" | "automation" | "preferences";

export function SettingsLoading({ section, desktop = false, onboarding = false }: {
  section: SettingsSection | "cfd" | "local-onboarding";
  desktop?: boolean;
  onboarding?: boolean;
}) {
  const t = useCopy();
  const label = section === "local-onboarding"
    ? t("正在读取本地工作区状态…", "Loading local workspace status…")
    : t("正在读取数据…", "Loading data…");
  const chinese = useLocale().locale === "zh";

  // Match the section heights of the unconfigured Settings layout. Connected providers,
  // imported rows and other data-dependent states can add content after the first read.
  function panel(height: string, children: React.ReactNode) {
    return (
      <Skeleton className={`mx-panel ${height}`}>
        <div className="mb-6 h-3 w-36 max-w-full rounded-full bg-muted max-[767px]:mb-4" />
        {children}
      </Skeleton>
    );
  }

  const heading = <div className="h-3 w-28 max-w-full rounded-full bg-secondary" />;
  const control = <div className="h-10 w-32 max-w-full rounded-full bg-muted pointer-coarse:h-11" />;
  const row = <div className="flex min-w-0 items-center justify-between gap-4">{heading}{control}</div>;
  const connection = (
    <div className="flex min-w-0 flex-col items-start gap-4 rounded-xl border border-border bg-background p-5 max-[767px]:rounded-none max-[767px]:border-0 max-[767px]:bg-transparent max-[767px]:px-0 max-[767px]:py-3">
      {heading}<div className="h-2.5 w-44 max-w-full rounded-full bg-muted" />{control}
    </div>
  );
  const field = <div className="flex min-w-0 flex-col gap-2">{heading}<div className="h-10 w-full rounded-full bg-muted pointer-coarse:h-11" /></div>;

  const cfdPanel = () => panel("min-h-[460px] max-[767px]:min-h-[569px]", (
    <div className="mt-8 grid gap-8">{control}{row}{field}</div>
  ));

  return (
    <div className="relative flex min-w-0 flex-col gap-[22px] max-[767px]:gap-6" data-settings-loading={section}>
      <LoadingStatus label={label} />
      {section === "accounts" && <>
        {panel("min-h-[265px] max-[767px]:min-h-[336px]", (
          <div className="grid grid-cols-2 gap-[18px] max-[767px]:grid-cols-1 max-[767px]:gap-0">{connection}{connection}</div>
        ))}
        {!onboarding && <>
          {panel(chinese ? "min-h-[156px] max-[767px]:min-h-[133px]" : "min-h-[156px] max-[767px]:min-h-[136px]", row)}
          {panel("min-h-[220px] max-[767px]:min-h-[206px]", row)}
          {panel("min-h-[202px] max-[767px]:min-h-[181px]", row)}
          {!desktop && cfdPanel()}
        </>}
      </>}
      {section === "local-onboarding" &&
        panel(chinese ? "min-h-[355px] max-[767px]:min-h-[393px]" : "min-h-[355px] max-[767px]:min-h-[461px]", (
          <div className="flex flex-col gap-mx-lg">
            <div className="flex flex-col gap-2">{heading}<div className="h-2.5 w-44 rounded-full bg-muted" /></div>
            <div className="flex flex-wrap gap-4">{heading}{heading}{heading}</div>
            <div className="rounded-xl bg-muted p-4">{heading}</div>
            {control}
            <div className="h-2.5 w-full rounded-full bg-muted" />
          </div>
        ))}
      {section === "cfd" && cfdPanel()}
      {section === "models" && <>
        {panel(chinese
          ? "min-h-[314px] max-[767px]:min-h-[609px]"
          : desktop ? "min-h-[332px]" : "min-h-[314px] max-[767px]:min-h-[667px]", (
          <div className="grid grid-cols-3 gap-[18px] max-[767px]:grid-cols-1 max-[767px]:gap-12">{connection}{connection}{connection}</div>
        ))}
        {panel(chinese ? "min-h-[371px] max-[767px]:min-h-[368px]" : "min-h-[371px] max-[767px]:min-h-[388px]", <div className="mt-12 grid gap-8">{field}{heading}{control}</div>)}
      </>}
      {section === "assistant" &&
        panel(chinese ? "min-h-[369px] max-[767px]:min-h-[291px]" : "min-h-[369px] max-[767px]:min-h-[351px]", <div className="grid gap-4">{row}{row}{row}{control}</div>)}
      {section === "automation" && <>
        {panel("min-h-[327px] max-[767px]:min-h-[253px]", <div className="grid gap-4">{row}{row}{row}{heading}</div>)}
        {panel(chinese ? "min-h-[161px] max-[767px]:min-h-[115px]" : "min-h-[161px] max-[767px]:min-h-[137px]", row)}
      </>}
      {section === "preferences" &&
        panel("min-h-[571px] max-[767px]:min-h-[826px]", (
          <div className="mt-10 grid grid-cols-2 gap-5 max-[767px]:grid-cols-1">
            {field}{field}{field}{field}{field}{field}{field}
          </div>
        ))}
    </div>
  );
}
