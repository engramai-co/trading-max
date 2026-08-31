"use client";

import { Group, Stack, Title } from "@mantine/core";

import { ContextHelp } from "@/components/context-help";
import { useLocale } from "@/components/locale-provider";

export function PageHeader({
  title,
  description,
  actions,
  density = "workspace",
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  density?: "hero" | "workspace" | "utility";
}) {
  const { locale } = useLocale();

  return (
    <Group
      align="flex-end"
      className="tm-page-header"
      component="header"
      gap="lg"
      justify="space-between"
      mb={density === "hero" ? "xl" : "lg"}
      wrap="wrap"
    >
      <Stack gap={6} maw={920} style={{ flex: "1 1 28rem", minWidth: 0 }}>
        <Group align="center" gap="xs" wrap="nowrap">
          <Title
            order={1}
            style={{
              letterSpacing: "-0.025em",
              fontSize:
                density === "hero"
                  ? "clamp(2rem, 5vw, 3.25rem)"
                  : density === "utility"
                    ? "clamp(1.65rem, 3vw, 2.35rem)"
                    : "clamp(1.85rem, 4vw, 2.8rem)",
            }}
          >
            {title}
          </Title>
          {description ? (
            <ContextHelp
              content={description}
              label={locale === "zh" ? "页面说明" : "About this page"}
              title={title}
            />
          ) : null}
        </Group>
      </Stack>
      {actions}
    </Group>
  );
}
