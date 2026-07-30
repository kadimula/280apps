// R2BlobStore is the production backing; the filesystem store is for tests (R2
// and its FixedLengthStream are Workers-only).
export { open, ErrNotFound, DeployErr, FsBlobStore } from './blobstore.js';
export { R2BlobStore } from './r2.js';
