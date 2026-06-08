import type { ChannelBinding, ChannelBindingRecord } from "./types.js";

export function channelBindingId(binding: ChannelBinding): string {
  return typeof binding === "string" ? binding : binding.channelId;
}

export function isChannelBindingRecord(binding: ChannelBinding): binding is ChannelBindingRecord {
  return typeof binding === "object";
}

export function bindingMatchesChannel(binding: ChannelBinding, channelId: string): boolean {
  return channelBindingId(binding) === channelId;
}

export function appendStringBinding(
  bindings: readonly ChannelBinding[],
  channelId: string,
): ChannelBinding[] {
  if (bindings.some((binding) => bindingMatchesChannel(binding, channelId))) {
    return [...bindings];
  }
  return [...bindings, channelId];
}

export function removeChannelBinding(
  bindings: readonly ChannelBinding[],
  channelId: string,
): ChannelBinding[] {
  return bindings.filter((binding) => !bindingMatchesChannel(binding, channelId));
}
