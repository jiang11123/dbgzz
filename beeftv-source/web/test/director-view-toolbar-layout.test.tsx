import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { DirectorViewToolbar } from "@/components/canvas/director/director-view-toolbar";

describe("导演台取景层级", () => {
    test("导演/机位是主操作，五个正交轴向在方向球可发现", () => {
        const markup = renderToStaticMarkup(<DirectorViewToolbar viewMode="free" onViewModeChange={() => {}} />);
        expect(markup).toContain("导演视角");
        expect(markup).toContain("机位视角");
        expect(markup).toContain('aria-label="方向球"');
        for (const label of ["俯视", "正视", "背视", "左视", "右视", "重置视角"]) expect(markup).toContain(`aria-label="${label}"`);
        expect(markup).not.toContain('aria-label="下方"');
    });
});
