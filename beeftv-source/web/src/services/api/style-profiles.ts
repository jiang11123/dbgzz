import { http } from "@/services/api/request";

export type UserStyleProfile = {
    id: string;
    userId: string;
    name: string;
    description: string;
    coverUrl: string;
    tagsJson: string;
    profileJson: string;
    favorite: boolean;
    lastUsedAt?: string;
    revision: number;
    createdAt: string;
    updatedAt: string;
};

export function listStyleProfiles() {
    return http.get<{ profiles: UserStyleProfile[] }>("/style-profiles");
}

export function createStyleProfile(profileJson: string) {
    return http.post<{ profile: UserStyleProfile }>("/style-profiles", { profileJson });
}

export function updateStyleProfile(id: string, profileJson: string) {
    return http.patch<{ profile: UserStyleProfile }>(`/style-profiles/${encodeURIComponent(id)}`, { profileJson });
}

export function setStyleProfileFavorite(id: string, favorite: boolean) {
    return http.patch<{ id: string; favorite: boolean }>(`/style-profiles/${encodeURIComponent(id)}/favorite`, { favorite });
}

export function touchStyleProfile(id: string) {
    return http.post<{ id: string }>(`/style-profiles/${encodeURIComponent(id)}/use`);
}

export function deleteStyleProfile(id: string) {
    return http.delete<{ id: string }>(`/style-profiles/${encodeURIComponent(id)}`);
}
