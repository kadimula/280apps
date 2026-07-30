// S3BlobStore is the production backing on the Node host (Cloudflare R2 over its
// S3 API); R2BlobStore is the Workers-binding backing; the filesystem store is for
// tests and the local loop.
export { open, ErrNotFound, DeployErr, FsBlobStore } from './blobstore.js';
export { R2BlobStore } from './r2.js';
export { S3BlobStore, openS3, type S3Config } from './s3.js';
