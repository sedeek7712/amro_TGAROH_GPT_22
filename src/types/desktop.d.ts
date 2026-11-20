export {};

declare global {
  interface Window {
    readonly amroDesktop?: {
      getRuntimeStatus(): Promise<{
        ready: boolean;
        databaseFile: string;
        schemaVersion: number;
        sqliteVersion: string;
      }>;
    };
  }
}
