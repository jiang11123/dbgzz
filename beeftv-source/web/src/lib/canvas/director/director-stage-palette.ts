import { Color } from "three";

/** Only new dark scenes use the charcoal stage. Existing light scenes retain their previous floor/grid. */
export function directorStagePalette(background: string): { ground: string; cell: string; section: string } {
    const color = new Color(background);
    const lightness = color.getHSL({ h: 0, s: 0, l: 0 }).l;
    return lightness < 0.22
        ? { ground: "#151820", cell: "#4a7094", section: "#5f8bb0" }
        : { ground: "#aeb7bf", cell: "#8f99a3", section: "#626d77" };
}
