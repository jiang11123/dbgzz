import { describe, expect, test } from "bun:test";
import { parseSpeechAudioEvents } from "@/lib/audio-speech-events";

const delta = `data: ${JSON.stringify({ type: "speech.audio.delta", audio: btoa("ID3music") })}\n\n`;
const done = `data: ${JSON.stringify({ type: "speech.audio.done" })}\n\n`;

describe("music SSE", () => {
    test("keeps heartbeat bytes out of audio and requires a real terminal event", () => {
        const result = parseSpeechAudioEvents(": PING\r\n\r\n" + delta + done);
        expect(new TextDecoder().decode(result.chunks[0])).toBe("ID3music");
        for (const body of [": PING\n\n", delta, done, delta + done + delta, delta + done + done, delta + 'data: {"error":{"message":"failed"}}\n\n']) {
            expect(() => parseSpeechAudioEvents(body)).toThrow();
        }
    });
    test("accepts a completed result URL but rejects credentials or mixed results", () => {
        const event = (url: string) => `data: ${JSON.stringify({ type: "speech.audio.done", audio_url: url })}\n\n`;
        expect(parseSpeechAudioEvents(event("https://cdn.example.com/audio.mp3")).url).toBe("https://cdn.example.com/audio.mp3");
        for (const url of ["file:///secret", "https://user:password@example.com/audio.mp3"]) expect(() => parseSpeechAudioEvents(event(url))).toThrow();
        expect(() => parseSpeechAudioEvents(delta + event("https://example.com/audio.mp3"))).toThrow();
    });
});
