import { Box, Text } from "ink";
import type { ReactNode } from "react";

import {
  formatTaskNotificationTitle,
  taskNotificationToLines,
  type ParsedTaskNotification,
} from "../taskNotification.js";

export function TaskNotificationCard({
  notification,
}: {
  notification: ParsedTaskNotification;
}): ReactNode {
  const lines = taskNotificationToLines(notification);
  const title = lines[0] ?? formatTaskNotificationTitle(notification);
  const rest = lines.slice(1);
  const isError =
    notification.status === "failed" ||
    notification.status === "killed" ||
    Boolean(notification.error);

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="single" paddingX={1}>
      <Text color={isError ? "red" : "green"} bold>
        {title}
      </Text>
      {rest.map((line, index) => (
        <Text key={`${line}-${index}`} dimColor={index > 1}>
          {line}
        </Text>
      ))}
    </Box>
  );
}
