import type { Plugin } from "@opencode-ai/plugin"
import { FastJevV1 } from "./v1.ts"
import { FastJevV2 } from "./v2.ts"

export { FastJevV1 } from "./v1.ts"
export { FastJevV2 } from "./v2.ts"

export default {
  ...FastJevV2,
  async server(input: Parameters<Plugin>[0], options?: Parameters<Plugin>[1]) {
    return FastJevV1(input, options)
  },
}
