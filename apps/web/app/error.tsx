"use client";
import Link from "next/link";
import { useEffect, useRef } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Empty, Page, Panel, useCopy } from "@/workspace/foundation";
export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useCopy();
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => title.current?.focus(), []);
  return (
    <Page
      title={t("这一页暂时无法显示", "This page could not be displayed")}
      headingRef={title}
    >
      <Panel>
        <Empty
          headingLevel={2}
          title={t(
            "尝试重新加载",
            "Try reloading",
          )}
          description={t(
            "重新加载此页面，或返回总览查看其他数据。",
            "Reload this page, or return to the overview to explore other data.",
          )}
          action={
            <div className="flex flex-wrap items-center gap-mx-md">
              <Button onClick={reset}>{t("重新加载", "Reload page")}</Button>
              <Link href="/" data-slot="button" className={buttonVariants({ variant: "secondary" })}>
                {t("返回总览", "Back to overview")}
              </Link>
            </div>
          }
        />
      </Panel>
    </Page>
  );
}
