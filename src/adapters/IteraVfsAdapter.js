import { FileSystemPort } from '../ports/FileSystemPort.js';

/**
 * Adapter for Itera OS Virtual File System (MetaOS.fs)
 */
export class IteraVfsAdapter extends FileSystemPort {
  constructor(metaOsFs) {
    super();
    this.fs = metaOsFs || (typeof MetaOS !== 'undefined' ? MetaOS.fs : null);
    if (!this.fs) {
      throw new Error('[IteraVfsAdapter] MetaOS.fs is not available');
    }
  }

  async read(path) {
    return await this.fs.read(path);
  }

  async write(path, content) {
    return await this.fs.write(path, content, { overwrite: true, silent: true });
  }

  async exists(path) {
    return await this.fs.exists(path);
  }

  async list(dir) {
    return await this.fs.list(dir);
  }
}