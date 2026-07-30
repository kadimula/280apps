// The container runtime, Workers-safe surface: the seam impl (ContainerRuntime),
// the build-home boundary (ContainerBuilder), and the Workers control-plane
// client (HttpBuilder). DockerBuilder is deliberately NOT re-exported here — it
// pulls in node:fs and node:child_process and must never enter the Workers
// bundle; the build host and node tests import it from ./docker-builder.js.
export {
  ContainerRuntime,
  FakeBuilder,
  buildFailed,
  type ContainerBuilder,
  type ContextFile,
  type RolloutJob,
  type RolloutResult,
} from './container.js';
export { HttpBuilder, type HttpBuilderConfig } from './http-builder.js';
