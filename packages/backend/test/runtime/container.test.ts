import { describe, expect, it } from 'vitest';
import {
  DeployErr,
  State,
  digestBytes,
  normalizeEgressPolicy,
  type Manifest,
} from '@280/contracts';
import type { ConfigDelivery, SecretDelivery } from '../../src/seams.js';
import { deliveryFailed } from '../../src/secret-delivery.js';
import { FakeBuilder } from '../../src/runtime/container/index.js';
import { bodyOf, newPlatform, portFor } from '../helpers/harness.js';

async function deploy(
  manifest: Manifest,
  contents: Uint8Array[],
  options: {
    builder?: FakeBuilder;
    secrets?: SecretDelivery;
    config?: ConfigDelivery;
    beforeUpload?: (appId: string, deployId: string, harness: Awaited<ReturnType<typeof newPlatform>>) => Promise<void>;
  } = {},
) {
  const harness = await newPlatform(options);
  const port = await portFor(harness);
  const synced = await port.sync({
    identity: {
      appId: '',
      slug: 'container-test',
      framework: 'next',
      gitRemote: '',
      clientRef: Math.random().toString(),
      forceNew: false,
    },
    manifest,
  });
  await options.beforeUpload?.(synced.app.id, synced.deployId, harness);
  for (const content of contents) {
    await port.putBlob(synced.app.id, digestBytes(content), content.byteLength, bodyOf(content));
  }
  return { harness, port, synced };
}

function deploymentManifest(files: Record<string, string>): { manifest: Manifest; contents: Uint8Array[] } {
  const contents = Object.values(files).map((content) => new TextEncoder().encode(content));
  return {
    manifest: {
      kind: 'container',
      build: { builder: 'next', dockerfile: 'Dockerfile', port: 8080 },
      files: Object.keys(files).map((path, index) => ({
        path,
        digest: digestBytes(contents[index]!),
        size: contents[index]!.byteLength,
      })),
    },
    contents,
  };
}

describe('ContainerDeploymentCoordinator', () => {
  it('builds and rolls out the complete container deployment', async () => {
    const input = deploymentManifest({ Dockerfile: 'FROM node:20', 'server.js': 'listen()' });
    const { harness } = await deploy(input.manifest, input.contents);
    try {
      expect(harness.builder.builds).toHaveLength(1);
      expect(harness.builder.rollouts).toHaveLength(1);
      expect(harness.builder.rollouts[0]!.deployment.files.map((file) => file.path).sort()).toEqual([
        'Dockerfile',
        'server.js',
      ]);
      expect(harness.builder.rollouts[0]!.deployment.build.port).toBe(8080);
    } finally {
      await harness.cleanup();
    }
  });

  it('normalizes egress policy', async () => {
    const input = deploymentManifest({ Dockerfile: 'FROM node:20' });
    input.manifest.egress = {
      allowedHosts: ['Data.Example.com'],
      credentials: [{ host: 'API.Stripe.com', secret: 'STRIPE_KEY', header: 'authorization', scheme: 'Bearer' }],
    };
    const { harness } = await deploy(input.manifest, input.contents, {
      beforeUpload: async (appId, _deployId, current) => {
        await current.store.putAppSecret({
          appId,
          name: 'STRIPE_KEY',
          envelope: '',
          setBy: 'owner@test',
          setAt: 1,
        });
      },
    });
    try {
      expect(harness.builder.rollouts[0]!.deployment.runtime.egress).toEqual(
        normalizeEgressPolicy(input.manifest.egress),
      );
    } finally {
      await harness.cleanup();
    }
  });

  it('defaults to an empty egress policy', async () => {
    const input = deploymentManifest({ Dockerfile: 'FROM node:20' });
    const { harness } = await deploy(input.manifest, input.contents);
    try {
      expect(harness.builder.rollouts[0]!.deployment.runtime.egress).toEqual({
        allowedHosts: [],
        credentials: [],
      });
    } finally {
      await harness.cleanup();
    }
  });

  it('delivers committed config', async () => {
    const input = deploymentManifest({ Dockerfile: 'FROM node:20' });
    input.manifest.config = [{ name: 'REGION', value: 'us-east-1', sensitive: false }];
    const { harness } = await deploy(input.manifest, input.contents);
    try {
      expect(harness.builder.rollouts[0]!.env).toEqual({ REGION: 'us-east-1' });
    } finally {
      await harness.cleanup();
    }
  });

  it('resolves dashboard config without delivering secret values', async () => {
    const input = deploymentManifest({ Dockerfile: 'FROM node:20' });
    input.manifest.secrets = ['SECRET_TOKEN'];
    input.manifest.config = [{ name: 'SHEET_ID', value: '', sensitive: true }];
    const config: ConfigDelivery = {
      resolve: async () => ({ SHEET_ID: 'revealed-sheet-id' }),
    };
    const { harness } = await deploy(input.manifest, input.contents, {
      config,
      beforeUpload: async (appId, _deployId, current) => {
        for (const name of ['SECRET_TOKEN', 'SHEET_ID']) {
          await current.store.putAppSecret({ appId, name, envelope: '', setBy: 'owner@test', setAt: 1 });
        }
      },
    });
    try {
      expect(harness.builder.rollouts[0]!.env).toEqual({ SHEET_ID: 'revealed-sheet-id' });
      expect(JSON.stringify(harness.builder.rollouts[0]!.env)).not.toContain('SECRET_TOKEN');
    } finally {
      await harness.cleanup();
    }
  });

  it('records builder failures', async () => {
    const builder = new FakeBuilder();
    builder.failNext(new DeployErr({ code: 'unavailable', message: 'build broke', retryable: false }));
    const input = deploymentManifest({ Dockerfile: 'FROM node:20' });
    const { harness, port, synced } = await deploy(input.manifest, input.contents, { builder });
    try {
      const status = await port.status(synced.app.id, synced.deployId);
      expect(status.state).toBe(State.Failed);
      expect(status.failure?.message).toBe('build broke');
    } finally {
      await harness.cleanup();
    }
  });

  it('records secret delivery failures', async () => {
    const input = deploymentManifest({ Dockerfile: 'FROM node:20' });
    input.manifest.secrets = ['API_KEY'];
    const secrets: SecretDelivery = {
      rollout: async () => {
        throw deliveryFailed(['API_KEY']);
      },
      set: async () => {},
      delete: async () => {},
    };
    const { harness, port, synced } = await deploy(input.manifest, input.contents, {
      secrets,
      beforeUpload: async (appId, _deployId, current) => {
        await current.store.putAppSecret({ appId, name: 'API_KEY', envelope: '', setBy: 'owner@test', setAt: 1 });
      },
    });
    try {
      const status = await port.status(synced.app.id, synced.deployId);
      expect(status.state).toBe(State.Failed);
      expect(status.failure?.message).toContain('API_KEY');
    } finally {
      await harness.cleanup();
    }
  });

  it('tears down the container when deleting an app', async () => {
    const input = deploymentManifest({ Dockerfile: 'FROM node:20' });
    const { harness, port, synced } = await deploy(input.manifest, input.contents);
    try {
      await port.delete({ appId: synced.app.id, confirm: synced.app.slug });
      expect(harness.builder.torndown).toEqual([synced.app.id]);
    } finally {
      await harness.cleanup();
    }
  });
});
