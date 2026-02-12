import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { pub } from './dispatcher';

export function watch() {
  const root = vscode.workspace.workspaceFolders?.[0];
  if (!root) return;

  // watch "./tmp/summary-*.json"
  const tmpDir = path.join(root.uri.fsPath, 'tmp');
  const pattern = new vscode.RelativePattern(tmpDir, 'summary-*.json');
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);

  const safeRead = (u: vscode.Uri) => {
    try {
      const content = fs.readFileSync(u.fsPath, 'utf8');
      const parsed = JSON.parse(content);
      if (!parsed.summary && !parsed.current_status) {
        console.error(`[Autopilot] Invalid JSON in ${u.fsPath}: missing summary and current_status`);
        return null;
      }
      return { summary: parsed.summary || '', current_status: parsed.current_status || '' };
    } catch (error) {
      console.error(`[Autopilot] Error reading/parsing ${u.fsPath}:`, error);
      return null;
    }
  };

  // Normalize path for consistent comparison (Windows: different slash/casing)
  const norm = (p: string) => path.normalize(path.resolve(p));

  // Track processed files to avoid duplicates
  const processedFiles = new Set<string>();
  
  // Get existing files and mark them as processed (don't send them)
  try {
    if (fs.existsSync(tmpDir)) {
      const existingFiles = fs.readdirSync(tmpDir)
        .filter(file => file.startsWith('summary-') && file.endsWith('.json'))
        .map(file => norm(path.join(tmpDir, file)));
      
      existingFiles.forEach(filePath => {
        processedFiles.add(filePath);
      });
      
      console.log(`[Autopilot] Marked ${existingFiles.length} existing summary files as processed`);
    }
  } catch (error) {
    console.error('[Autopilot] Error reading existing files:', error);
  }

  // Longer delay on Windows so file is fully flushed to disk before reading
  const fileReadyDelay = process.platform === 'win32' ? 450 : 200;

  const processFile = (u: vscode.Uri) => {
    const key = norm(u.fsPath);
    if (processedFiles.has(key)) return;
    processedFiles.add(key);
    setTimeout(() => {
      const d = safeRead(u);
      if (d) {
        pub('summary', d);
        console.log('[Autopilot] Published summary to adapters (Telegram etc.):', u.fsPath);
      } else {
        processedFiles.delete(key);
      }
    }, fileReadyDelay);
  };

  watcher.onDidCreate(u => processFile(u));
  watcher.onDidChange(u => processFile(u));

  // Polling fallback: FileSystemWatcher can miss events on Windows
  const pollInterval = setInterval(() => {
    try {
      if (!fs.existsSync(tmpDir)) return;
      const files = fs.readdirSync(tmpDir)
        .filter((f) => f.startsWith('summary-') && f.endsWith('.json'))
        .map((f) => path.join(tmpDir, f));
      for (const fp of files) {
        const key = norm(fp);
        if (processedFiles.has(key)) continue;
        processedFiles.add(key);
        const d = safeRead(vscode.Uri.file(fp));
        if (d) {
          pub('summary', d);
          console.log('[Autopilot] Published summary via polling:', fp);
        } else {
          processedFiles.delete(key);
        }
      }
    } catch (e) {
      console.error('[Autopilot] Poll error:', e);
    }
  }, 3000);

  const disposable = {
    dispose: () => {
      watcher.dispose();
      clearInterval(pollInterval);
    }
  };

  return disposable;
}
