// Provider endpoint contracts, not limits inferred from a model's display name.
// Sources and unverified providers: docs/backend/video-prompt-limits.
export function videoPromptLimits(protocol = "", model = "") {
    const name = model.trim().toLowerCase().split("/").pop() || "";
    let promptMaxChars = 0;
    let promptMaxUtf16Units = 0;
    if (protocol === "full-video") promptMaxChars = 4000;
    if (["openai", "openai-videos", "newapi"].includes(protocol) && /^sora-2(?:-pro)?$/.test(name)) promptMaxChars = 32000;
    if (protocol === "minimax-video" && ["minimax-h3", "minimax-h3-max"].includes(name)) promptMaxChars = 7000;
    if (protocol === "dashscope-wan-video") {
        if (/^wan3[.-]0/.test(name)) promptMaxChars = 20000;
        else if (/^wan2[.-]7/.test(name)) promptMaxChars = 5000;
        else if (/^wan2[.-][56]/.test(name)) promptMaxChars = 1500;
        else if (/^wan2[.-][12]/.test(name)) promptMaxChars = 800;
    }
    if (protocol === "volcengine-jimeng-video" && name === "jimeng_t2v_v30") promptMaxChars = 800;
    if (protocol === "luma-dream-machine" && ["ray-2", "ray-flash-2"].includes(name)) promptMaxChars = 5000;
    if (protocol === "pixverse-video" && ["v6-max", "c1", "v6", "v3.5", "v4", "v4.5", "v5", "v5-fast", "v5.5", "v5.6"].includes(name)) promptMaxChars = 5000;
    if (protocol === "zhipu-cogvideox" && ["cogvideox-3", "cogvideox-2", "cogvideox-flash", "viduq1-text", "viduq1-image", "vidu2-image", "viduq1-start-end", "vidu2-start-end", "vidu2-reference"].includes(name)) promptMaxChars = 512;
    if (protocol === "runway-video") {
        if (["gen4.5", "gen4_turbo", "veo3.1", "veo3.1_fast"].includes(name)) promptMaxUtf16Units = 1000;
        else if (name === "happyhorse_1_0") promptMaxUtf16Units = 2500;
        else if (name === "seedance2_5") promptMaxChars = 15000;
        else if (["seedance2", "seedance2_fast", "seedance2_mini"].includes(name)) promptMaxChars = 3500;
        else if (["hailuo3", "h3_max"].includes(name)) promptMaxChars = 6000;
        else if (["klingo3_4k", "kling3.0_4k", "kling2.5_turbo_pro", "kling3.0_pro", "kling3.0_standard", "klingo3_pro", "klingo3_standard", "grok_imagine_1_5", "grok_imagine_1_5_lite"].includes(name)) promptMaxChars = 2500;
        else if (["wan3", "wan3_prime"].includes(name)) promptMaxChars = 20000;
        else if (["gemini_omni_flash", "gemini_omni_flash_1.1"].includes(name)) promptMaxChars = 4000;
    }
    // Ark does not publish a character hard limit. Veo uses tokens, not chars.
    // Unknown/third-party/workflow limits remain with the supplier or explicit profile.
    return { promptMaxChars, promptMaxUtf16Units };
}
