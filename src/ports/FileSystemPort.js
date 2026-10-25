/**
 * FileSystemPort: File I/O abstraction boundary.
 * Allows Specula to run identically on Node.js (node:fs) and Itera OS (MetaOS.fs).
 */
export class FileSystemPort {
  async read(path) { throw new Error('Not implemented'); }
  async write(path, content) { throw new Error('Not implemented'); }
  async exists(path) { throw new Error('Not implemented'); }
  async list(dir) { throw new Error('Not implemented'); }
}