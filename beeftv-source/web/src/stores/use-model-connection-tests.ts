import { create } from "zustand";
import { channelConnectionSignature, type ModelChannel } from "./use-config-store";

export type ModelConnectionReceipt = { signature: string; success: boolean; detail: string };

// Session-only evidence: changing credentials, protocol or capabilities makes
// an old test inapplicable. Neither credentials nor receipts enter browser storage.
export function modelConnectionTestSignature(channel: ModelChannel, model: string) {
    return `${channelConnectionSignature(channel)}\n${model}\n${JSON.stringify(channel.modelProfiles?.find((item) => item.model === model))}`;
}

export const useModelConnectionTests = create<{ receipts: Record<string, ModelConnectionReceipt>; record: (channel: ModelChannel, model: string, receipt: Omit<ModelConnectionReceipt, "signature">) => void }>((set) => ({
    receipts: {},
    record: (channel, model, receipt) => set((state) => ({ receipts: { ...state.receipts, [`${channel.id}::${model}`]: { ...receipt, signature: modelConnectionTestSignature(channel, model) } } })),
}));

export function currentModelConnectionReceipt(receipts: Record<string, ModelConnectionReceipt>, channel: ModelChannel, model: string) {
    const receipt = receipts[`${channel.id}::${model}`];
    return receipt?.signature === modelConnectionTestSignature(channel, model) ? receipt : undefined;
}
