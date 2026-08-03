// The container runtime, Workers-safe surface: the seam impl (ContainerRuntime)
// and the build-home boundary (ContainerBuilder). Concrete node build homes
// (DepotBuilder) pull in node:fs and node:child_process and must never enter the
// Workers bundle; the node tests import them directly from their own module.
export { ContainerRuntime, FakeBuilder, type ContainerBuilder } from './container.js';
