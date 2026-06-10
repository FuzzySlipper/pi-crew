import type { ChannelContent, ChannelMessage } from "@pi-crew/core";

export function withReplyIdentity(
  content: ChannelContent,
  message: ChannelMessage,
): ChannelContent {
  const senderIdentity = replyIdentityFromMessage(message);
  if (senderIdentity === null) return content;
  return { ...content, metadata: { ...(content.metadata ?? {}), senderIdentity } };
}

function replyIdentityFromMessage(message: ChannelMessage): string | null {
  const metadata = message.metadata ?? {};
  return (
    stringMetadata(metadata, "targetMemberIdentity") ?? stringMetadata(metadata, "memberIdentity")
  );
}

function stringMetadata(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}
