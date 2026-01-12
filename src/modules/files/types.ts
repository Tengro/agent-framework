/**
 * Types for the Files module
 */

// ============================================================================
// Index State (snapshot)
// ============================================================================

/**
 * Workspace index - tracks all files and their state IDs.
 */
export interface WorkspaceIndex {
  /** Map of file path to file entry */
  files: Record<string, FileEntry>;
  /** Counter for generating unique state IDs */
  nextStateId: number;
}

/**
 * Entry for a single file in the index.
 */
export interface FileEntry {
  /** State ID for this file's content log */
  stateId: string;
  /** File size in bytes */
  size: number;
  /** Hash of current content (for quick comparison) */
  hash: string;
  /** Creation timestamp */
  createdAt: number;
  /** Last modification timestamp */
  modifiedAt: number;
}

// ============================================================================
// Content Log Entries (append_log)
// ============================================================================

/**
 * Entry types for file content log.
 */
export type ContentLogEntry =
  | ContentInitEntry
  | ContentEditEntry
  | ContentWriteEntry;

/**
 * Initial file content.
 */
export interface ContentInitEntry {
  type: 'init';
  content: string;
}

/**
 * Edit operation - string replacement.
 */
export interface ContentEditEntry {
  type: 'edit';
  /** String to find */
  oldString: string;
  /** String to replace with */
  newString: string;
  /** If true, replace all occurrences */
  replaceAll?: boolean;
}

/**
 * Full file replacement.
 */
export interface ContentWriteEntry {
  type: 'write';
  content: string;
}

// ============================================================================
// Tool Inputs
// ============================================================================

export interface ReadInput {
  /** Path to the file to read */
  filePath: string;
  /** Starting line (1-indexed, optional) */
  offset?: number;
  /** Number of lines to read (optional) */
  limit?: number;
}

export interface WriteInput {
  /** Path to the file to write */
  filePath: string;
  /** Content to write */
  content: string;
}

export interface EditInput {
  /** Path to the file to edit */
  filePath: string;
  /** String to find and replace */
  oldString: string;
  /** String to replace with */
  newString: string;
  /** If true, replace all occurrences (default: false) */
  replaceAll?: boolean;
}

export interface GlobInput {
  /** Glob pattern to match files */
  pattern: string;
  /** Directory to search in (optional, defaults to workspace root) */
  path?: string;
}

export interface GrepInput {
  /** Regular expression pattern to search for */
  pattern: string;
  /** File or directory to search in (optional) */
  path?: string;
  /** Glob pattern to filter files (optional) */
  glob?: string;
  /** Number of context lines before match */
  contextBefore?: number;
  /** Number of context lines after match */
  contextAfter?: number;
}

export interface MaterializeInput {
  /** Target directory to write files to */
  targetDir: string;
  /** Specific files to materialize (optional, defaults to all) */
  files?: string[];
}

export interface SyncInput {
  /** Source directory to sync from */
  sourceDir: string;
  /** Specific files to sync (optional, defaults to all) */
  files?: string[];
}

// ============================================================================
// Module Configuration
// ============================================================================

export interface FilesModuleConfig {
  /** Namespace prefix for states (default: 'workspace') */
  namespace?: string;
  /** Delta snapshot frequency for content logs (default: 20) */
  deltaSnapshotEvery?: number;
  /** Full snapshot frequency for content logs (default: 10) */
  fullSnapshotEvery?: number;
  /** Maximum file size in bytes (default: 5MB) */
  maxFileSize?: number;
}
