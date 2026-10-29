import { http } from "@/services/api/request";

export type PromptTemplate = {
    id: string;
    operation: string;
    name: string;
    version: number;
    content: string;
    outputType: "json" | "text";
    enabled: boolean;
    createdAt: string;
    updatedAt: string;
};

export type PromptOperationDefinition = {
    operation: string;
    label: string;
    category: string;
    description: string;
    outputType: "json" | "text";
    schemaKey?: string;
    variables: Array<{ label: string; placeholder: string }>;
    outputContract: string;
};

export type UserPromptCustomization = {
    id: string;
    operation: string;
    mode: "inherit" | "append" | "rewrite";
    content: string;
    baseTemplateId: string;
    updatedAt: string;
};

export type UserPromptPreference = {
    definition: PromptOperationDefinition;
    template: PromptTemplate | null;
    customization?: UserPromptCustomization;
    outdated: boolean;
};

export function listUserPromptPreferences() {
    return http.get<{ preferences: UserPromptPreference[] }>("/settings/prompt-templates");
}

export function updateUserPromptCustomization(operation: string, input: Pick<UserPromptCustomization, "mode" | "content">) {
    return http.patch<{ customization: UserPromptCustomization }>(`/settings/prompt-templates/${encodeURIComponent(operation)}`, input);
}

export function resetUserPromptCustomization(operation: string) {
    return http.delete<{ ok: boolean }>(`/settings/prompt-templates/${encodeURIComponent(operation)}`);
}
