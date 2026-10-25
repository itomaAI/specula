import { FileSystemPort } from '../ports/FileSystemPort.js';

/**
 * Adapter for Standalone Node.js File System (node:fs/promises)
 */
export class NodeFsAdapter extends FileSystemPort {
  constructor() {
    super();
  }

  async read(path) {
    const fs = await import('node:fs/promises');
    return await fs.readFile(path, 'utf-8');
  }

  async write(path, content) {
    const fs = await import('node:fs/promises');
    const pathModule = await import('node:path');
    await fs.mkdir(pathModule.dirname(path), { recursive: true });
    return await fs.writeFile(path, content, 'utf-8');
  }

  async exists(path) {
    const fs = await import('node:fs/promises');
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }

  async list(dir) {
    const fs = await import('node:fs/promises');
    return await fs.readdir(dir);
  }
}