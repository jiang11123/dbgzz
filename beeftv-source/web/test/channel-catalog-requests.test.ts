import { expect, test } from "bun:test";
import { createChannelCatalogRequests } from "../src/services/channel-catalog-requests";

test("delete/edit cancellation invalidates delayed catalog results", () => {
    const requests = createChannelCatalogRequests();
    const first = requests.start("channel");
    requests.cancel("channel");
    expect(first.signal.aborted).toBe(true);
    expect(requests.current("channel", first)).toBe(false);
    const second = requests.start("channel");
    requests.finish("channel", first);
    expect(requests.current("channel", second)).toBe(true);
    requests.cancelAll();
    expect(second.signal.aborted).toBe(true);
});

test("a replacement request prevents an earlier result from overwriting it", () => {
    const requests = createChannelCatalogRequests();
    const first = requests.start("channel");
    const second = requests.start("channel");
    expect(first.signal.aborted).toBe(true);
    expect(requests.current("channel", first)).toBe(false);
    requests.finish("channel", second);
    expect(requests.current("channel", second)).toBe(false);
});
