import { getContainer } from '@cloudflare/containers';
import { handleAppRequest } from '@280/gateway/appworker';

export { App280Container, ContainerProxy } from './container.js';

export default {
  async fetch(request, env) {
    return handleAppRequest(request, env, { container: getContainer(env.APP) });
  },
};
