"use client";

import { ActionIcon, Popover, Stack, Text } from "@mantine/core";
import type { TransitionOverride } from "@mantine/core";
import { Question } from "@phosphor-icons/react";

const contextHelpTransition: TransitionOverride = {
  duration: 160,
  exitDuration: 120,
  timingFunction: "cubic-bezier(0.23, 1, 0.32, 1)",
  transition: {
    in: { opacity: 1, transform: "scale(1)" },
    out: { opacity: 0, transform: "scale(0.97)" },
    transitionProperty: "transform, opacity",
  },
};

export function ContextHelp({
  content,
  label,
  title,
}: {
  content: React.ReactNode;
  label: string;
  title?: React.ReactNode;
}) {
  return (
    <Popover
      position="bottom-start"
      shadow="md"
      transitionProps={contextHelpTransition}
      width={320}
      withArrow
    >
      <Popover.Target>
        <ActionIcon
          aria-label={label}
          color="gray"
          size={44}
          variant="subtle"
        >
          <Question aria-hidden="true" size={16} />
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown className="tm-context-help-popover">
        <Stack gap={4}>
          {title ? <Text fw={700} size="sm">{title}</Text> : null}
          <Text c="dimmed" size="sm">{content}</Text>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
