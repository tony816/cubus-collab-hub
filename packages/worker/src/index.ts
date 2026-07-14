import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { app } from "./oauth.js";
import { CubusMCP } from "./mcp.js";

export { CubusMCP };

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: CubusMCP.serve("/mcp"),
  defaultHandler: app,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});

