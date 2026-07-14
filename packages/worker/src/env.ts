export type WorkerSecrets = {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  COOKIE_ENCRYPTION_KEY: string;
  ACTIONS_API_TOKEN: string;
  BRIDGE_API_TOKEN: string;
  WEBHOOK_SHARED_SECRET: string;
  DISCORD_WEBHOOK_URL: string;
  ALLOWED_GITHUB_LOGIN: string;
};

export type AppEnv = Env & WorkerSecrets;

export type OAuthProps = {
  login: string;
  name: string;
  email: string | null;
};

