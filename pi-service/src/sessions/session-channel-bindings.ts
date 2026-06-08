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

export function appendChannelBinding(
  bindings: readonly ChannelBinding[],
  binding: ChannelBinding,
): ChannelBinding[] {
  if (bindings.some((existing) => bindingMatchesChannel(existing, channelBindingId(binding)))) {
    return [...bindings];
  }
  return [...bindings, binding];
}

export function removeChannelBinding(
  bindings: readonly ChannelBinding[],
  channelId: string,
): ChannelBinding[] {
  return bindings.filter((binding) => !bindingMatchesChannel(binding, channelId));
}
