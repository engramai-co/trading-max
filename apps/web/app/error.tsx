"use client";

import { Alert, Button, Group, Stack, Text } from "@mantine/core";
import { ArrowClockwise, House, WarningCircle } from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect } from "react";

import { useLocale } from "@/components/locale-provider";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { locale } = useLocale();
  useEffect(() => console.error(error), [error]);
  return (
    <Alert color="red" icon={<WarningCircle size={24} />} title={locale === "zh" ? "页面无法加载" : "Page could not load"}>
      <Stack gap="md">
        <Text>{locale === "zh" ? "请重试，或返回总览继续查看其他数据。" : "Try again, or return to the overview to view other data."}</Text>
        <Group>
          <Button leftSection={<ArrowClockwise size={17} />} onClick={reset}>{locale === "zh" ? "重试" : "Retry"}</Button>
          <Button component={Link} href="/" leftSection={<House size={17} />} variant="default">{locale === "zh" ? "返回总览" : "Back to overview"}</Button>
        </Group>
        {error.digest ? <Text c="dimmed" size="xs">{locale === "zh" ? "错误编号" : "Error reference"}: {error.digest}</Text> : null}
      </Stack>
    </Alert>
  );
}
