import {
  LarkPlatformAdapter,
  type LarkPlatformOptions,
} from './adapter.js';
import { ProductionLarkSdkFactory } from './sdk.js';

export function createLarkPlatformAdapter(
  options: LarkPlatformOptions,
): LarkPlatformAdapter {
  return new LarkPlatformAdapter(options, {
    sdkFactory: new ProductionLarkSdkFactory(options.logger),
  });
}

export {
  LarkConfigError,
  parseLarkBindingMatchConfig,
  parseLarkPlatformConfig,
  type LarkBindingMatchConfig,
  type LarkPlatformConfig,
} from './config.js';
export {
  LARK_CAPABILITIES,
  LarkPartialSendError,
  LarkPlatformError,
  LarkPlatformAdapter,
  type LarkPlatformOptions,
} from './adapter.js';
