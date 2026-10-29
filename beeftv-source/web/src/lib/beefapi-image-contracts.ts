import contracts from "../../../backend/internal/providerpreset/image_contracts.json";

export function beefAPIImageContract(model: string) {
    return contracts.find((contract) => contract.model === (model.split("::").pop() || "").trim().toLowerCase());
}
