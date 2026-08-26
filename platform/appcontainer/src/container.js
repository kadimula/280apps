import { Container } from '@cloudflare/containers';
import { parseConfig, parseSecrets, parseSdkApi } from './config.js';

export { ContainerProxy } from '@cloudflare/containers';

export class App280Container extends Container {
  defaultPort = 8080;
  sleepAfter = '2m';
  // The app talks to providers directly with its own credentials: no allowlist,
  // no HTTPS interception. allowedHosts stays unset (an empty array would deny all).
  enableInternet = true;

  constructor(ctx, env) {
    super(ctx, env);
    const sdkApi = parseSdkApi(env && env.TWO80_SDK_API_ORIGIN);
    this.envVars = {
      ...parseConfig(env && env.TWO80_CONFIG),
      ...parseSecrets(env, env && env.TWO80_SECRET_NAMES),
      ...(sdkApi.origin === '' ? {} : { TWO80_API: sdkApi.origin }),
    };
  }
}
