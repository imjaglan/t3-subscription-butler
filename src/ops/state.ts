import { readFile, writeFile } from "node:fs/promises";

/**
 * Tiny deploy-state file so re-runs of `npm run deploy` are idempotent and
 * other scripts (invoke, agent) can find the registered contract without
 * hardcoding ids. Lives next to package.json; safe to commit (no secrets —
 * contract id and tail are public registry data).
 */
export interface DeployState {
  readonly contractId: number;
  readonly tail: string;
  readonly version: string;
  readonly tenantDid: string;
  readonly deployedAt: string;
}

const STATE_PATH = new URL("../../.butler-deploy.json", import.meta.url);

export async function readDeployState(): Promise<DeployState | null> {
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<DeployState>;
    if (
      typeof parsed.contractId !== "number" ||
      typeof parsed.tail !== "string" ||
      typeof parsed.version !== "string" ||
      typeof parsed.tenantDid !== "string"
    ) {
      throw new Error("malformed .butler-deploy.json — delete it and re-run npm run deploy");
    }
    return parsed as DeployState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function writeDeployState(state: DeployState): Promise<void> {
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
