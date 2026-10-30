export type MoveToApplicationsFolderResult = "continue-bootstrap" | "stop-bootstrap";

export interface MoveToApplicationsFolderOptions {
  readonly platform: NodeJS.Platform;
  readonly isLabBuild: boolean;
  readonly app: {
    readonly isPackaged: boolean;
    isInApplicationsFolder?(): boolean;
    moveToApplicationsFolder?(): boolean;
  };
  confirmMove(): Promise<boolean>;
  reportFailure(error: unknown): Promise<void>;
  reportSecondaryFailure?(error: unknown): void;
}

export async function moveToApplicationsFolderIfNeeded(
  options: MoveToApplicationsFolderOptions,
): Promise<MoveToApplicationsFolderResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" || !options.app?.isPackaged || options.isLabBuild) return "continue-bootstrap";
  try {
    if (typeof options.app.isInApplicationsFolder !== "function" || options.app.isInApplicationsFolder()) return "continue-bootstrap";
    if (!await options.confirmMove()) return "continue-bootstrap";
    return options.app.moveToApplicationsFolder?.() ? "stop-bootstrap" : "continue-bootstrap";
  } catch (error) {
    try {
      await options.reportFailure(error);
    } catch (reportError) {
      options.reportSecondaryFailure?.(reportError);
    }
    return "continue-bootstrap";
  }
}
