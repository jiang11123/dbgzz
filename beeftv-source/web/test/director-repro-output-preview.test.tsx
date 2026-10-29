import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { DirectorReproOutputPreview } from "../src/pages/dev/director-repro-output-preview";

test("复现页可查看并下载最近生成的参考图和白膜视频", () => {
    const html = renderToStaticMarkup(<DirectorReproOutputPreview beautyUrl="blob:beauty" clayVideoUrl="blob:clay" />);
    expect(html).toContain('aria-label="最近生成的参考素材"');
    expect(html).toContain('src="blob:beauty"');
    expect(html).toContain('src="blob:clay"');
    expect(html).toContain('download="导演台参考图.png"');
    expect(html).toContain('download="导演台白膜视频.webm"');
});
