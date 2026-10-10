# Download Feedback and Video Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make manual Doubao downloads visibly report progress and completion, retain one deduplicated file, and show it in the video library with its account.

**Architecture:** The Electron main process owns one download lifecycle per account session and emits typed IPC status events. It writes a manual download record to SQLite only after `DownloadItem` reports `completed`; the renderer subscribes to the status events and presents a transient notification. Existing canvas tasks keep their canvas completion behavior.

**Tech Stack:** Electron 33, TypeScript, React 18, better-sqlite3.

## Global Constraints

- Download files remain local under the configured download directory or `Downloads\\DoubaoWorkspace`.
- A failed or cancelled download must never be added to the video library.
- The same source video is protected from duplicate concurrent downloads for the active account.
- Existing canvas-bridge download completion must remain supported.

---

### Task 1: Download lifecycle domain behavior

**Files:**
- Create: `src/main/download-tracker.test.ts`
- Create: `src/main/download-tracker.ts`
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Write failing tests** for accepting a first `(accountId, sourceUrl)` request, rejecting the second concurrent request, and releasing the key after completion.
- [ ] **Step 2: Run the TypeScript test with Electron's Node test runner** and confirm it fails because `download-tracker.ts` does not exist.
- [ ] **Step 3: Implement `DownloadTracker`** with `begin`, `finish`, and `keyFor` methods using an in-memory `Set`.
- [ ] **Step 4: Re-run the test** and confirm all tracker tests pass.

### Task 2: Main-process persistence and status events

**Files:**
- Modify: `src/main/database.ts`
- Modify: `src/main/main.ts`
- Modify: `src/preload/preload.ts`
- Modify: `src/renderer/env.d.ts`
- Test: `src/main/download-tracker.test.ts`

- [ ] **Step 1: Write a failing test** for tracker-driven duplicate prevention before changing the Electron handler.
- [ ] **Step 2: Add `manual_downloads` storage and a `recordManualDownload` method** returning the video library row only after a completed `.mp4` file exists.
- [ ] **Step 3: Update `will-download` handling** to emit `started`, `completed`, `failed`, and `duplicate` events; call the DB method on completion; release the tracker key for every terminal state.
- [ ] **Step 4: Expose `onDownloadStatus` through preload** and add its renderer declaration.
- [ ] **Step 5: Run tests and typecheck** to verify no event/type regressions.

### Task 3: User-facing completion feedback

**Files:**
- Modify: `src/renderer/src.tsx`
- Modify: `src/renderer/styles.css`

- [ ] **Step 1: Add a failing source-level assertion or component test** that subscribes to `onDownloadStatus` and refreshes workspace data after completion.
- [ ] **Step 2: Add a transient download notification** showing account name, filename, and status; on completion, refresh data so the Video Library immediately includes it.
- [ ] **Step 3: Style the notification** for loading, success, duplicate, and failure states without covering the embedded Doubao controls.
- [ ] **Step 4: Run the app typecheck and production build**.

### Task 4: End-to-end smoke verification

**Files:**
- No source changes expected.

- [ ] **Step 1: Start the rebuilt Electron app.**
- [ ] **Step 2: Download one video from a selected account.** Verify one status notification, one file in the configured folder, and one Video Library record bearing that account.
- [ ] **Step 3: Click the same download again while it is active.** Verify the duplicate notice and no second active request.
