/// <reference types="vite/client" />

declare global {
  interface Window { workspace: {
    setImageBarHeight: (height: number, save?: boolean) => Promise<number>;
    setAccountBarHeight: (height: number, save?: boolean) => Promise<number>;
    renameAccount: (id: number, name: string) => Promise<void>;
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
  selectFiles: () => Promise<string[]>;
  importImagePaths: (paths: string[]) => Promise<import('../shared/types').ImageAsset[]>;
    removeImageAsset: (id: string) => Promise<import('../shared/types').ImageAsset[]>;
    useImageAssets: (ids: string[], accountId: number) => Promise<boolean>;
    parseShare: (text: string) => Promise<{ result?: import('../shared/types').ShareParseResult; error?: string }>;
    saveShare: (id: string) => Promise<{ path?: string; error?: string }>;
    onBrowserError: (listener: (message: string) => void) => () => void;
    setBrowserFullscreen: (value: boolean) => Promise<boolean>;
    openSettings: () => Promise<boolean>;
    openDonation: () => Promise<boolean>;
    setAccountShortcut: (index: number, shortcut: string) => Promise<Record<string,string>>;
    resetAccountShortcuts: () => Promise<Record<string,string>>;
    onAccountOpened: (listener: (accountId: number) => void) => () => void;
    load: () => Promise<any>; listVideos: () => Promise<any[]>; updateAccount: (id: number, patch: unknown) => Promise<any>; deleteAccount: (id: number) => Promise<any>; createAccount: (data: unknown) => Promise<any>; openAccount: (id: number) => Promise<any>; hideBrowser: () => Promise<any>; onBrowserFullscreenChanged: (listener: (value: boolean) => void) => () => void; onDownloadStatus: (listener: (payload: { state: 'started' | 'completed' | 'failed' | 'duplicate'; accountId: number; name: string; path?: string; reason?: string }) => void) => () => void;
    createProject: (name: string) => Promise<any>; listTasks: (projectId?: number) => Promise<any>; createTask: (data: unknown) => Promise<any>; updateTask: (id: number, patch: unknown) => Promise<any>; completeTask: (id: number, videoPath: string, accountId: number) => Promise<any>;
    selectImages: () => Promise<string[]>; selectDirectory: () => Promise<string>; watchDownloads: (directory: string) => Promise<string>; openFile: (target: string) => Promise<any>; fileUrl: (target: string) => Promise<string>; openFolder: (target: string) => Promise<any>; addAsset: (projectId: number, taskId: number | null, type: 'image' | 'video', filePath: string) => Promise<number>;
    onChanged: (listener: () => void) => () => void; onDownload: (listener: (candidate: { path: string; name: string }) => void) => () => void;
    probeAccount: (id: number) => Promise<{ ok: boolean; reason?: string }>;
  gatewayStatus: () => Promise<{ url: string; enabled: boolean; running: boolean; port: number; apiKey: string; error: string | null; requests: number; model: string; accounts: { accountId: number; name: string; health: string; available: boolean; dailyUsed: number; cooldownRemainingMs: number }[] }>;
    openGateway: () => Promise<boolean>;
    gatewayRestart: (config: { port?: number; apiKey?: string; enabled?: boolean }) => Promise<{ url: string; enabled: boolean; running: boolean; port: number; apiKey: string; error: string | null; requests: number; model: string; accounts: { accountId: number; name: string; health: string; available: boolean; dailyUsed: number; cooldownRemainingMs: number }[] }>;
    gatewayCopy: (text: string) => Promise<boolean>;
    onGatewayChanged: (listener: () => void) => () => void;
    onGatewayLog: (listener: (message: string) => void) => () => void;
    chatThreads: () => Promise<import('../shared/types').GatewayThread[]>;
    chatMessages: (threadId: string) => Promise<import('../shared/types').GatewayMessage[]>;
    chatCreate: (model?: string) => Promise<import('../shared/types').GatewayThread>;
    chatRename: (id: string, title: string) => Promise<import('../shared/types').GatewayThread>;
    chatDelete: (id: string) => Promise<import('../shared/types').GatewayThread[]>;
    chatSend: (request: { threadId?: string; prompt: string; model?: string; deepThink?: boolean; accountId?: number | null; attachments?: import('../shared/types').StagedAttachment[]; imageAssetIds?: string[] }) => Promise<{ thread: import('../shared/types').GatewayThread; userMessage: import('../shared/types').GatewayMessage; assistantMessage: import('../shared/types').GatewayMessage }>;
    onChatDelta: (listener: (payload: { threadId?: string; full: string }) => void) => () => void;
    chatImages: (request: { threadId?: string; prompt: string; model?: string; ratio?: string; accountId?: number | null; attachments?: import('../shared/types').StagedAttachment[] }) => Promise<{ thread: import('../shared/types').GatewayThread; userMessage: import('../shared/types').GatewayMessage; assistantMessage: import('../shared/types').GatewayMessage }>;
    chatVideos: (request: { threadId?: string; prompt: string; model?: string; ratio?: string; duration?: number; accountId?: number | null; attachments?: import('../shared/types').StagedAttachment[] }) => Promise<{ thread: import('../shared/types').GatewayThread; userMessage: import('../shared/types').GatewayMessage; assistantMessage: import('../shared/types').GatewayMessage }>;
    chatConfirm: (request: { threadId?: string; text?: string }) => Promise<boolean>;
  getAppMode: () => Promise<'gateway' | 'account'>;
    setAppMode: (mode: 'gateway' | 'account') => Promise<'gateway' | 'account'>;
    onAppModeChanged: (listener: (mode: 'gateway' | 'account') => void) => () => void;
  } }
}
export {};
