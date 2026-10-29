import { beforeAll } from "bun:test";
import localforage from "localforage";
import "./localforage-bun-memory";

// Production modules configure the default instance before tests install spies.
beforeAll(async () => { await localforage.ready(); });
