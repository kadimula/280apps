import { Container } from '@cloudflare/containers';
import { parseConfig, parseSdkApi } from './config.js';

export { ContainerProxy } from '@cloudflare/containers';

export class App280Container extends Container {
  defaultPort = 8080;
  sleepAfter = '2m';
  enableInternet = false;
  interceptHttps = true;

  constructor(ctx, env) {
    super(ctx, env);
    const sdkApi = parseSdkApi(env && env.TWO80_SDK_API_ORIGIN);
    this.allowedHosts = sdkApi.host === '' ? [] : [sdkApi.host];
    this.envVars = {
      ...parseConfig(env && env.TWO80_CONFIG),
      ...(sdkApi.origin === '' ? {} : { TWO80_API: sdkApi.origin }),
    };
  }
}
