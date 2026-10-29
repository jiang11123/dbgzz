import contracts from "../../../backend/internal/providerpreset/video_contracts.json";

type VideoContract = {
    models: string[];
    allowSuffix: boolean;
    protocol: string;
    inlineMedia: boolean;
    requiresHTTPReferences?: boolean;
    // An omitted kind keeps the model's existing capability limit, matching Go.
    maxReferences?: Partial<Record<"image" | "video" | "audio", number>>;
    operations?: string[];
    resolutions?: string[];
    referenceResolution?: string;
    ratios?: string[];
    duration?: { min: number; max: number; default: number };
    maxImageDuration?: number;
    generateAudio?: boolean;
};

export function isBeefAPIEndpoint(baseUrl: string): boolean {
    try {
        const url = new URL(baseUrl.trim());
        return url.protocol === "https:" && ["beeftv.app", "enterprise.beefapi.com"].includes(url.hostname) && !url.username && !url.password && (!url.port || url.port === "443");
    } catch { return false; }
}

export function beefAPIVideoContract(model: string): VideoContract | undefined {
    const name = model.trim().toLowerCase();
    return contracts.find((contract) => contract.models.some((prefix) => name === prefix || (contract.allowSuffix && name.startsWith(`${prefix}-`))));
}
