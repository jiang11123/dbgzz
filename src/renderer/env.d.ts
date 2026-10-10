/// <reference types="vite/client" />

declare global {
  interface Window { workspace: {
    setImageBarHeight: (height: number, save?: boolean) => Promise<number>;
    setAccountBarHeight: (height: number, save?: boolean) => Promise<number>;
    moveAccount: (id: number, targetId: number, before: boolean) => Promise<import('../shared/types').Account[]>;
    messageSyncState: () => Promise<{draft: {id:string;sourceAccountId:number;targetId:number;prompt:string;assetIds:string[];kind:string;warning?:string}|null; accounts:import('../shared/types').Account[];images:(import('../shared/types').ImageAsset|undefined)[]}>;
    readMessageImages: (kind:'draft'|'latest'|'loaded') => Promise<boolean>;
    submitMessageImages: (request:{id:string;targetId:number;assetIds:string[];send:boolean}) => Promise<boolean>;
    onAccountSendStatus: (listener: (message: string) => void) => () => void;
    confirmDeleteAccount: (id: number) => Promise<boolean>;
    listQuickImages: () => Promise<import('../shared/types').ImageAsset[]>;
    addQuickImages: (ids: string[]) => Promise<import('../shared/types').ImageAsset[]>;
    removeQuickImages: (ids: string[]) => Promise<import('../shared/types').ImageAsset[]>;
    reorderQuickImages: (ids: string[]) => Promise<import('../shared/types').ImageAsset[]>;
    dragImageAssets: (ids: string[]) => void;
    onImageAssetsChanged: (listener: () => void) => () => void;
    openImageAssets: () => Promise<boolean>;
    listImageAssets: () => Promise<{ items: import('../shared/types').ImageAsset[]; accountId: number | null }>;
    importImageAssets: () => Promise<import('../shared/types').ImageAsset[]>;
    removeImageAsset: (id: string) => Promise<import('../shared/types').ImageAsset[]>;
    useImageAssets: (ids: string[], accountId: number) => Promise<boolean>;
    listUpscales: () => Promise<import('../shared/types').UpscaleJob[]>;
    startUpscale: (paths: string[], target: import('../shared/types').UpscaleTarget) => Promise<import('../shared/types').UpscaleJob[]>;
    cancelUpscales: () => Promise<void>;
    configureUpscale: () => Promise<string>;
    onUpscaleChanged: (listener: () => void) => () => void;
    parseShare: (text: string) => Promise<{ result?: import('../shared/types').ShareParseResult; error?: string }>;
    saveShare: (id: string) => Promise<{ path?: string; error?: string }>;
    onBrowserError: (listener: (message: string) => void) => () => void;
    setBrowserFullscreen: (value: boolean) => Promise<boolean>;
    openSettings: () => Promise<boolean>;
    setAccountShortcut: (index: number, shortcut: string) => Promise<Record<string,string>>;
    resetAccountShortcuts: () => Promise<Record<string,string>>;
    onAccountOpened: (listener: (accountId: number) => void) => () => void;
    load: () => Promise<any>; listVideos: () => Promise<any[]>; updateAccount: (id: number, patch: unknown) => Promise<any>; deleteAccount: (id: number) => Promise<any>; createAccount: (data: unknown) => Promise<any>; openAccount: (id: number) => Promise<any>; hideBrowser: () => Promise<any>; onBrowserFullscreenChanged: (listener: (value: boolean) => void) => () => void; onDownloadStatus: (listener: (payload: { state: 'started' | 'completed' | 'failed' | 'duplicate'; accountId: number; name: string; path?: string; reason?: string }) => void) => () => void;
    createProject: (name: string) => Promise<any>; listTasks: (projectId?: number) => Promise<any>; createTask: (data: unknown) => Promise<any>; updateTask: (id: number, patch: unknown) => Promise<any>; completeTask: (id: number, videoPath: string, accountId: number) => Promise<any>;
    selectImages: () => Promise<string[]>; selectDirectory: () => Promise<string>; watchDownloads: (directory: string) => Promise<string>; openFile: (target: string) => Promise<any>; fileUrl: (target: string) => Promise<string>; openFolder: (target: string) => Promise<any>; addAsset: (projectId: number, taskId: number | null, type: 'image' | 'video', filePath: string) => Promise<number>;
    onChanged: (listener: () => void) => () => void; onDownload: (listener: (candidate: { path: string; name: string }) => void) => () => void;
  } }
}
export {};
