import { chromium } from "playwright";

const baseURL = process.env.BEEFTV_URL || "http://127.0.0.1:3000";
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const routes = ["/", "/projects", "/project", "/assets", "/canvas", "/tasks", "/settings?section=models", "/create"];
const localApiPrefixes = [
    "/api/workspace/",
    "/api/openapi.yaml",
    "/api/health/",
    "/api/system/version",
    "/api/projects",
    "/api/project-folders",
    "/api/resources",
    "/api/tasks",
    "/api/skills",
    "/api/plugins",
    "/api/style-profiles",
    "/api/agent",
    "/api/creation",
    "/api/canvas-projects",
    "/api/voice-profiles",
    "/api/features",
];
const failures = [];
const report = [];

function isAllowedLocalApiPath(pathname) {
    return localApiPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(prefix));
}

const browser = await chromium.launch({ headless: true, executablePath: chrome });
const context = await browser.newContext({ viewport: { width: 1470, height: 716 }, deviceScaleFactor: 1 });
const page = await context.newPage();
// Keep a failed UI contract explicit instead of allowing a selector wait to
// hang for the browser's much longer default timeout.
page.setDefaultTimeout(10_000);

try {
    for (const route of routes) {
        const requests = [];
        const listener = (request) => requests.push(request.url());
        page.on("request", listener);
        await page.goto(`${baseURL}${route}`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector(".app-user-workspace", { timeout: 10_000 });
        await page.waitForTimeout(500);
        if (route.startsWith("/settings")) {
            const bodyText = await page.locator("body").innerText();
            const forbiddenLocalLabels = ["RunningHub", "我的对象存储", "支付充值", "积分运营", "积分超市", "充值 / 兑换"];
            const visibleForbiddenLabels = forbiddenLocalLabels.filter((label) => bodyText.includes(label));
            if (visibleForbiddenLabels.length) {
                failures.push(`${route}: local settings rendered hosted/commercial labels: ${visibleForbiddenLabels.join(", ")}`);
            }
        }
        page.off("request", listener);

        const apiRequests = requests.filter((url) => {
            const pathname = new URL(url).pathname;
            return pathname.startsWith("/api/") && pathname !== "/api/workspace/bootstrap";
        });
        // /workspace/model-config is the local Go workspace file boundary,
        // not cloud user-data synchronization. Keep it visible in apiRequests
        // while excluding it from the cloud-sync assertion.
        const cloudSyncRequests = apiRequests.filter((url) => /\/api\/(user-data|assets|tasks)(?:\/|\?|$)/.test(new URL(url).pathname));
        const commercialRequests = apiRequests.filter((url) => /\/api\/(wallet|announcements|banner-announcements)(?:\/|\?|$)/.test(new URL(url).pathname));
        const remoteAppearanceRequests = apiRequests.filter((url) => new URL(url).pathname === "/api/public/appearance");
        const unknownLocalApiRequests = apiRequests.filter((url) => !isAllowedLocalApiPath(new URL(url).pathname));
        report.push({ route, apiRequests, cloudSyncRequests, commercialRequests });
        if (cloudSyncRequests.length) {
            failures.push(`${route}: local mode issued cloud-sync data requests: ${cloudSyncRequests.join(", ")}`);
        }
        if (commercialRequests.length) {
            failures.push(`${route}: local mode issued commercial data requests: ${commercialRequests.join(", ")}`);
        }
        if (remoteAppearanceRequests.length) {
            failures.push(`${route}: local mode issued remote appearance requests: ${remoteAppearanceRequests.join(", ")}`);
        }
        if (unknownLocalApiRequests.length) {
            failures.push(`${route}: API request is not in the local allowlist: ${unknownLocalApiRequests.join(", ")}`);
        }
        if (requests.some((url) => !url.startsWith(baseURL) && !url.startsWith("http://localhost"))) {
            const external = requests.filter((url) => !url.startsWith(baseURL) && !url.startsWith("http://localhost"));
            failures.push(`${route}: unexpected external request(s): ${external.join(", ")}`);
        }
    }

    // 关键链路：点击项目库「开始创作」并进入画布，整个创建过程也不能触发云端用户数据写入。
    await page.goto(`${baseURL}/project`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".lib-tv-project-page", { timeout: 10_000 });
    const createRequests = [];
    const createListener = (request) => createRequests.push({ url: request.url(), method: request.method() });
    page.on("request", createListener);
    await page.getByRole("button", { name: /开始创作|新建画布/u }).first().click({ timeout: 10_000 });
    await page.waitForURL(/\/canvas\/[^/]+$/, { timeout: 15_000 });
    await page.waitForTimeout(600);
    const canvasBodyText = await page.locator("body").innerText();
    const forbiddenCanvasLabels = ["云端历史", "云端版本待确认", "积分超市", "开通会员", "积分余额"];
    const visibleForbiddenCanvasLabels = forbiddenCanvasLabels.filter((label) => canvasBodyText.includes(label));
    if (visibleForbiddenCanvasLabels.length) {
        failures.push(`local canvas rendered hosted/commercial labels: ${visibleForbiddenCanvasLabels.join(", ")}`);
    }
    page.off("request", createListener);
    const createCloudSyncRequests = createRequests.filter(({ url }) => /\/api\/(user-data|assets)(?:\/|\?|$)/.test(new URL(url).pathname));
    const createCommercialRequests = createRequests.filter(({ url }) => /\/api\/(wallet|announcements|banner-announcements)(?:\/|\?|$)/.test(new URL(url).pathname));
    const createRemoteAppearanceRequests = createRequests.filter(({ url }) => new URL(url).pathname === "/api/public/appearance");
    report.push({ route: "projects -> local canvas create", apiRequests: createRequests, cloudSyncRequests: createCloudSyncRequests, commercialRequests: createCommercialRequests });
    if (createCloudSyncRequests.length) {
        failures.push(`local canvas create issued cloud-sync data requests: ${createCloudSyncRequests.map(({ method, url }) => `${method} ${url}`).join(", ")}`);
    }
    if (createCommercialRequests.length) {
        failures.push(`local canvas create issued commercial data requests: ${createCommercialRequests.map(({ method, url }) => `${method} ${url}`).join(", ")}`);
    }
    if (createRemoteAppearanceRequests.length) {
        failures.push(`local canvas create issued remote appearance requests: ${createRemoteAppearanceRequests.map(({ method, url }) => `${method} ${url}`).join(", ")}`);
    }

    // 兼容旧项目详情 URL 时仍必须留在本地画布边界，不能加载远程短剧工作台。
    const localCanvasId = new URL(page.url()).pathname.split("/").filter(Boolean).pop();
    if (localCanvasId) {
        const legacyRouteRequests = [];
        const legacyRouteListener = (request) => legacyRouteRequests.push({ url: request.url(), method: request.method() });
        page.on("request", legacyRouteListener);
        await page.goto(`${baseURL}/projects/${localCanvasId}`, { waitUntil: "domcontentloaded" });
        await page.waitForURL(new RegExp(`/canvas/${localCanvasId}$`), { timeout: 10_000 });
        await page.waitForTimeout(400);
        page.off("request", legacyRouteListener);
        const legacyCloudSyncRequests = legacyRouteRequests.filter(({ url }) => /\/api\/(user-data|assets)(?:\/|\?|$)/.test(new URL(url).pathname));
        const legacyProjectRequests = legacyRouteRequests.filter(({ url }) => /\/api\/projects(?:\/|\?|$)/.test(new URL(url).pathname));
        report.push({ route: "legacy project detail -> local canvas", apiRequests: legacyRouteRequests, cloudSyncRequests: legacyCloudSyncRequests, commercialRequests: [] });
        if (legacyCloudSyncRequests.length || legacyProjectRequests.length) {
            failures.push(`legacy project detail escaped local mode: ${legacyRouteRequests.map(({ method, url }) => `${method} ${url}`).join(", ")}`);
        }
    }
} finally {
    await browser.close();
}

console.log(JSON.stringify({ routes: report.length, failures, report }, null, 2));
if (failures.length) process.exit(1);
console.log(`BeefTV local network audit passed for ${report.length} routes.`);
