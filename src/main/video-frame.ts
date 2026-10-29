import path from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { BrowserWindow } from 'electron';

/**
 * Automatically extracts the final frame of an MP4/WebM video file as a PNG image.
 * Uses ffmpeg if available on PATH; otherwise spins up a temporary off-screen BrowserWindow.
 */
export async function extractLastFrame(videoPath: string, outputPath?: string): Promise<string | null> {
  if (!existsSync(videoPath)) return null;
  const destination = outputPath || `${videoPath.replace(/\.[^.]+$/, '')}_lastframe.png`;
  if (existsSync(destination)) return destination;

  mkdirSync(path.dirname(destination), { recursive: true });

  // 1. Try ffmpeg first if available
  const ffmpegOk = await tryExtractWithFfmpeg(videoPath, destination);
  if (ffmpegOk && existsSync(destination)) {
    return destination;
  }

  // 2. Fallback to off-screen Electron BrowserWindow with HTML5 Video + Canvas
  const electronOk = await tryExtractWithElectron(videoPath, destination);
  if (electronOk && existsSync(destination)) {
    return destination;
  }

  return null;
}

function tryExtractWithFfmpeg(videoPath: string, outputPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const proc = spawn('ffmpeg', [
        '-y',
        '-sseof', '-0.1',
        '-i', videoPath,
        '-frames:v', '1',
        '-q:v', '2',
        outputPath,
      ], { windowsHide: true });

      const timer = setTimeout(() => {
        try { proc.kill(); } catch { /* ignore */ }
        resolve(false);
      }, 8000);

      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
      proc.on('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}

async function tryExtractWithElectron(videoPath: string, outputPath: string): Promise<boolean> {
  let win: BrowserWindow | null = null;
  try {
    win = new BrowserWindow({
      show: false,
      width: 800,
      height: 600,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: false, // allow loading local file:// video
      },
    });

    const fileUrl = `file:///${videoPath.replace(/\\/g, '/')}`;
    const html = `<!DOCTYPE html>
<html>
<body>
  <video id="v" src="${fileUrl}" muted preload="auto" playsinline></video>
  <script>
    window.__captureLastFrame = function() {
      return new Promise((resolve, reject) => {
        const v = document.getElementById('v');
        const timer = setTimeout(() => reject('timeout waiting for video'), 10000);
        v.addEventListener('loadedmetadata', () => {
          v.currentTime = Math.max(0, v.duration - 0.1);
        });
        v.addEventListener('seeked', () => {
          clearTimeout(timer);
          try {
            const canvas = document.createElement('canvas');
            canvas.width = v.videoWidth || 1280;
            canvas.height = v.videoHeight || 720;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL('image/png'));
          } catch(e) {
            reject(String(e));
          }
        });
        v.addEventListener('error', (e) => {
          clearTimeout(timer);
          reject('video error');
        });
      });
    };
  </script>
</body>
</html>`;

    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const dataUrl = await win.webContents.executeJavaScript('window.__captureLastFrame()') as string;

    if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/png;base64,')) {
      const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
      writeFileSync(outputPath, Buffer.from(base64, 'base64'));
      return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (win && !win.isDestroyed()) {
      win.destroy();
    }
  }
}
