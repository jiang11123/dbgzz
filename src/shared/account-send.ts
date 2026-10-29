export interface ComposerSettings {
  mode: 'chat' | 'video' | 'image' | 'other';
  model?: string;
  ratio?: string;
  duration?: number;
  modeLabel?: string;
}
export interface AccountCapabilities extends ComposerSettings {
  models: string[];
  ratios: string[];
  accountInfo: string[];
}
