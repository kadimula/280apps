// The container runtime, Workers-safe surface: the seam impl (ContainerRuntime),
// the build-home boundary (ContainerBuilder), and the Workers control-plane
// client (HttpBuilder). Concrete node build homes (DepotBuilder) pull in node:fs
// and node:child_process and must never enter the Workers bundle; the build host
// and node tests import them directly from their own module.
export { ContainerRuntime, FakeBuilder, type ContainerBuilder } from './container.js';
export { HttpBuilder } from './http-builder.js';
