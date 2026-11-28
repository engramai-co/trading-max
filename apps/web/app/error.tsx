"use client";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { documentTitle, useDocumentTitle } from "@/workspace/document-title";
import { Empty, Page, Panel, StatusMessage, useCopy } from "@/workspace/foundation";
import Link from "@/workspace/link";

export default function ErrorPage() {
  const t = useCopy();
  const pathname = usePathname();
  const overviewFailed = pathname === "/" || pathname === "/desktop";
  const title = t("这一页暂时无法显示", "This page could not be displayed");
  const heading = useRef<HTMLHeadingElement>(null);
  const [reloading, setReloading] = useState(false);
  const loadingLabel = t("正在重新加载…", "Reloading…");
  useDocumentTitle(documentTitle(title), "status");
  useEffect(() => heading.current?.focus(), []);

  return (
    <Page title={title} headingRef={heading}>
      <StatusMessage message={reloading ? loadingLabel : undefined} />
      <Panel>
        <Empty
          headingLevel={2}
          title={t("尝试重新加载", "Try reloading")}
          description={overviewFailed ? t(
            "重新加载此页面，或打开持仓查看其他数据。",
            "Reload this page, or open holdings to explore other data.",
          ) : t(
            "重新加载此页面，或返回总览查看其他数据。",
            "Reload this page, or return to the overview to explore other data.",
          )}
          action={
            <div className="flex flex-wrap items-center gap-mx-md">
              <Button loading={reloading} loadingLabel={loadingLabel} onClick={() => {
                setReloading(true);
                // A component reset reuses the failed reads from this document's QueryClient.
                window.location.reload();
              }}>{t("重新加载", "Reload page")}</Button>
              <Link href={overviewFailed ? "/holdings" : "/"} data-slot="button" className={buttonVariants({ variant: "secondary" })}>
                {overviewFailed ? t("打开持仓", "Open holdings") : t("返回总览", "Back to overview")}
              </Link>
            </div>
          }
        />
      </Panel>
    </Page>
  );
}
