export type AccountPlatform = 'doubao' | 'dola';

export function platformConfig(platform: AccountPlatform, accountId: number) {
  return platform === 'dola'
    ? { label: 'Dola', homeUrl: 'https://www.dola.com/', sessionName: `persist:dola_${String(accountId).padStart(2, '0')}` }
    : { label: '豆包', homeUrl: 'https://www.doubao.com/', sessionName: `persist:doubao_${String(accountId).padStart(2, '0')}` };
}
