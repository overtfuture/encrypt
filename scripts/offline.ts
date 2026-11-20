import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Plugin } from 'vite';

export function offlineShell(): Plugin {
  return {
    name: 'encrypt-offline-shell',
    apply: 'build',
    writeBundle: {
      order: 'post',
      async handler(output, bundle) {
        if (!output.dir || !bundle['index.html']) {
          throw new Error(
            'Offline support requires the built app’s index.html.',
          );
        }
        const directory = output.dir;
        const worker = await readFile(
          new URL('./offline-worker.js', import.meta.url),
          'utf8',
        );
        const files = [
          ...Object.keys(bundle).filter((file) => !file.endsWith('.map')),
          'app.webmanifest',
          'favicon.svg',
        ].sort();
        const entries = await Promise.all(
          files.map(async (file) => {
            const bytes = await readFile(join(directory, file));
            const digest = createHash('sha256').update(bytes).digest('base64');
            return [file === 'index.html' ? './' : file, `sha256-${digest}`];
          }),
        );
        const manifest = JSON.stringify(entries);
        const release = createHash('sha256')
          .update(manifest)
          .update(worker)
          .digest('hex');
        await writeFile(
          join(directory, 'sw.js'),
          `const release = ${JSON.stringify(release)};\nconst files = ${manifest};\n${worker}`,
        );
      },
    },
  };
}
