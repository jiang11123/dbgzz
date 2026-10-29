/** libass can exit 0 after logging a font failure. Match the native renderer. */
const SUBTITLE_FONT_FAILURES = [
    "failed to find any fallback",
    "no usable fontconfig",
    "fontselect: failed",
    "can't find selected font provider",
    "couldn't find font family",
    "failed to find font",
    "no fonts found",
    "missing glyph",
];

/**
 * True only for unrecoverable subtitle font failures.
 * "Glyph ... not found, selecting one more font" is a normal fallback attempt.
 */
export function isSubtitleFontFailure(output: string): boolean {
    const text = output.toLowerCase();
    return SUBTITLE_FONT_FAILURES.some((failure) => text.includes(failure));
}
