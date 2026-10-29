import { compactApiParams, http } from "./request";

export type CreationConversationDocument = {
    id: string;
    title?: string;
    updatedAt?: string;
    canvasId?: string;
    messages: Array<Record<string, unknown> & { id: string; role: "user" | "assistant" }>;
    [key: string]: unknown;
};

export type CreationConversationRecord = {
    id: string;
    revision: number;
    updatedAt: string;
    deleted?: boolean;
    document?: CreationConversationDocument;
};

export type CreationConversationList = {
    conversations: CreationConversationRecord[];
    deletedIds: string[];
};

export type CreationConversationImportResult = {
    imported: boolean;
    id: string;
    deleted?: boolean;
    conversation: CreationConversationRecord;
};

const path = (id: string) => `/creation-conversations/${encodeURIComponent(id)}`;

export const creationConversationsApi = {
    list: (signal?: AbortSignal) => http.get<CreationConversationList>("/creation-conversations", { signal }),
    get: (id: string, signal?: AbortSignal) => http.get<CreationConversationRecord>(path(id), { signal }),
    put: (id: string, input: { expectedRevision: number; document: CreationConversationDocument }, signal?: AbortSignal) =>
        http.put<CreationConversationRecord>(path(id), input, { signal }),
    remove: (id: string, expectedRevision: number, signal?: AbortSignal) =>
        http.delete<CreationConversationRecord>(path(id), { params: compactApiParams({ expectedRevision }), signal }),
    importLegacy: (input: { operationId: string; hash?: string; document: CreationConversationDocument }, signal?: AbortSignal) =>
        http.post<CreationConversationImportResult>("/creation-conversations/import", input, { signal }),
};
